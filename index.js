/**
 * dsh-auth-cookie-guard — Host half.
 *
 * Serves one same-origin route family under `/api/dsh-auth-cookie-guard`:
 *
 *   GET  /status    report what the current request carried; never deletes.
 *   GET  /purge     expire every stale generated cookie, keep the current one.
 *   GET  /settings  read the effective settings (resource, GET-only).
 *   POST /settings  validate and persist a settings change through configEditor.
 *
 * `/status` and `/purge` are resource routes: they receive a `Request` and
 * return a `Response`, which is also what lets `set-cookie` reach the browser.
 * `/settings` is an exact handler route instead, because resources answer GET
 * and HEAD only — a handler is the only shape that can read a POST body.
 *
 * Why a route and not a cleanup job: the Desktop Host is a plain Node child of
 * Electron, so it cannot reach Chromium's cookie jar (the Cookies database is
 * even exclusively locked while the app runs). The browser, however, applies a
 * `Set-Cookie: <name>=; Max-Age=0` from any same-origin response — that is the
 * one supported way to remove an HttpOnly cookie from the jar without touching
 * the profile on disk.
 *
 * Safety rules:
 *   - Loopback `Host` plus a custom request header fence every route against
 *     DNS-rebinding and cross-site requests.
 *   - Only cookies shaped like a generated `dsh-auth-<digest>` name are touched.
 *   - The cookie of the authority serving the request is always kept; when it
 *     is absent the plan is abandoned rather than risk logging the page out.
 *   - Settings writes accept only the three editable keys and go through the
 *     profile's own config layer (`configEditor`), never a hand-written file.
 *
 * @module index.js
 */

import {
  DEFAULT_SETTINGS,
  HEADER_BUDGET_BYTES,
  SettingsInputError,
  cookieNameForAuthority,
  normalizeSettings,
  planPurge,
  riskOf,
  serializeExpiredCookie,
  validateSettingsPatch,
} from './core.mjs'

export const name = 'dsh-auth-cookie-guard'

/**
 * No hard service dependency: the profile may be a non-Web one, where the
 * plugin simply stays inactive. `ctx.inject` waits for the web server instead.
 */
export const inject = []

/** Longest-prefix route; the connection RPC guard owns the shorter `/api`. */
export const ROUTE_PREFIX = '/api/dsh-auth-cookie-guard'

/** Exact route used for reading and writing the settings. */
export const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`

/** Same-origin marker header; a cross-site form cannot set it. */
export const CLIENT_HEADER = 'x-dsh-auth-cookie-guard'
export const CLIENT_HEADER_VALUE = '1'

/**
 * The Host header must be a loopback literal. This blocks DNS-rebinding
 * requests whose Origin is an attacker-controlled domain resolving to 127.0.0.1.
 */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d{1,5})?$/i

/** Largest accepted settings body; the payload is three scalars. */
const MAX_SETTINGS_BODY = 8 * 1024

/**
 * Session counters live at module scope so a settings save — which reloads the
 * plugin row — does not erase the "last purge" line from the settings page.
 */
const session = { last: null, purges: 0, purgedTotal: 0 }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const settings = normalizeSettings(config)
  const state = session
  const runtime = { server: undefined }
  const logger = ctx.logger
  const isEditable = () => configEditorOf(ctx) !== undefined
  const resource = createHandler({ runtime, settings, state, logger, isEditable })
  const settingsHandler = createSettingsHandler({ ctx, settings, logger })

  // webServer is published by the browser composition, which may activate
  // after this plugin; ctx.inject waits for it and re-registers if replaced.
  ctx.inject(['webServer'], (scoped) => {
    const server =
      scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer') : undefined)
    if (server === undefined || server === null || typeof server.register !== 'function') return
    runtime.server = server
    scoped.effect(() => {
      const disposers = []
      try {
        // `resource`, not `handler`: a handler route is called as `(req, res)`
        // and must write the response itself, while a resource route gets a
        // Request and returns a Response, which lets `set-cookie` through.
        disposers.push(server.register({ kind: 'prefix', path: ROUTE_PREFIX, resource }))
        // Settings writes need the POST body, which only a handler receives.
        disposers.push(server.register({ kind: 'exact', path: SETTINGS_PATH, handler: settingsHandler }))
      } catch (error) {
        for (const dispose of disposers) dispose?.()
        throw error
      }
      return () => {
        for (const dispose of disposers) dispose?.()
      }
    }, 'dsh-auth-cookie-guard: routes')
  })
}

/**
 * Build the route handler. Exported for tests, which pass a stub runtime.
 * @param {{
 *   runtime: { server?: { getOrigin?: () => string } },
 *   settings: { enabled: boolean, dryRun: boolean, warnAt: number },
 *   state: { last: object | null, purges: number, purgedTotal: number },
 *   logger?: { info?: (message: string) => void, warn?: (message: string) => void },
 *   now?: () => Date,
 *   isEditable?: () => boolean,
 * }} input - handler dependencies.
 * @returns {(request: Request) => Promise<Response>} the resource function.
 */
export function createHandler({ runtime, settings, state, logger, now = () => new Date(), isEditable = () => false }) {
  async function respond(request) {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return jsonResponse(400, { ok: false, error: 'bad-request' })
    }

    if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      return jsonResponse(404, { ok: false, error: 'not-found' })
    }

    const fence = requestFence(request)
    if (fence !== undefined) {
      return jsonResponse(403, { ok: false, error: 'forbidden', message: fence })
    }

    const method = String(request.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      return jsonResponse(405, { ok: false, error: 'method-not-allowed', allow: 'GET, HEAD' })
    }

    const origin = readOrigin(runtime)
    const plan = planPurge({ cookieHeader: readCookieHeader(request), origin })
    const action = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const at = now().toISOString()

    if (action === '/') {
      return jsonResponse(200, {
        ok: true,
        plugin: name,
        at,
        message: 'dsh-auth-cookie-guard is running; use /status or /purge.',
      })
    }

    if (action === '/status') {
      return jsonResponse(200, buildSnapshot({ origin, plan, settings, state, at, editable: isEditable() === true }))
    }

    if (action !== '/purge') {
      return jsonResponse(404, { ok: false, error: 'not-found' })
    }

    const manual = url.searchParams.get('manual') === '1'
    const allowed = manual || settings.enabled !== false
    const deleteNow = allowed && (manual || settings.dryRun !== true)
    const purge = deleteNow ? plan.purge : []
    const headers = purge.map((cookieName) => serializeExpiredCookie(cookieName))

    if (allowed) {
      state.last = {
        at,
        origin,
        carried: plan.carriedCount,
        headerBytes: plan.headerBytes,
        purged: purge.length,
        kept: plan.skipped === null && plan.currentPresent ? plan.currentName : null,
        skipped: plan.skipped,
        dryRun: !deleteNow,
        manual,
      }
      if (purge.length > 0) {
        state.purges += 1
        state.purgedTotal += purge.length
        // Counts only: cookie values and names stay out of the log.
        logger?.info?.(
          `dsh-auth-cookie-guard: expired ${String(purge.length)} stale cookies ` +
            `(carried ${String(plan.carriedCount)}, ~${String(plan.headerBytes)} bytes)`,
        )
      }
    }

    const snapshot = buildSnapshot({ origin, plan, settings, state, at, editable: isEditable() === true })
    return jsonResponse(
      200,
      {
        ...snapshot,
        purge: {
          requested: true,
          manual,
          allowed,
          deleted: purge.length,
          dryRun: !deleteNow,
          truncated: plan.truncated,
        },
      },
      headers,
    )
  }

  // A resource that throws would reject the server's write and leave the socket
  // open, so the failure is answered here instead of escaping.
  return async function handle(request) {
    try {
      return await respond(request)
    } catch (error) {
      logger?.warn?.(
        `dsh-auth-cookie-guard: route failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return jsonResponse(500, { ok: false, error: 'internal-error' })
    }
  }
}

/**
 * Read the web server origin without letting a pre-listen throw escape.
 * @param {{ server?: { getOrigin?: () => string } }} runtime - live registration handles.
 * @returns {string | undefined} for example `http://127.0.0.1:13708`.
 */
function readOrigin(runtime) {
  try {
    const origin = runtime?.server?.getOrigin?.()
    return typeof origin === 'string' && origin.length > 0 ? origin : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {Request} request - incoming request.
 * @returns {string | undefined} raw Cookie request header.
 */
function readCookieHeader(request) {
  try {
    return request.headers.get('cookie') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The shared body of /status and /purge.
 * @param {{
 *   origin: string | undefined,
 *   plan: ReturnType<typeof planPurge>,
 *   settings: { enabled: boolean, dryRun: boolean, warnAt: number },
 *   state: { last: object | null, purges: number, purgedTotal: number },
 *   at: string,
 *   editable: boolean,
 * }} input - observed values.
 * @returns {Record<string, unknown>} JSON-safe snapshot.
 */
function buildSnapshot({ origin, plan, settings, state, at, editable = false }) {
  const risk = riskOf({
    carriedCount: plan.carriedCount,
    headerBytes: plan.headerBytes,
    warnAt: settings.warnAt,
  })
  return {
    ok: true,
    plugin: name,
    at,
    origin: origin ?? null,
    authority: plan.authority,
    currentName: plan.currentName,
    currentNameShort: plan.currentName === null ? null : shortenCookieName(plan.currentName),
    currentPresent: plan.currentPresent,
    carried: plan.carriedCount,
    stale: plan.staleCount,
    headerBytes: plan.headerBytes,
    budgetBytes: HEADER_BUDGET_BYTES,
    risk,
    skipped: plan.skipped,
    settings: { enabled: settings.enabled, dryRun: settings.dryRun, warnAt: settings.warnAt },
    defaults: { ...DEFAULT_SETTINGS },
    editable: editable === true,
    last: state.last,
    totals: { purges: state.purges, purged: state.purgedTotal },
  }
}

/**
 * Short display form of a generated cookie name.
 * @param {string} cookieName - full `dsh-auth-<digest>` name.
 * @returns {string} prefix plus six digest characters.
 */
function shortenCookieName(cookieName) {
  return `${cookieName.slice(0, 9)}…${cookieName.slice(-6)}`
}

/**
 * Resolve the profile's config editor, which persists settings into the
 * profile's own patch layer and reconciles the Loader afterwards.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {{ entries: Function, edit: Function } | undefined} the editor, when usable.
 */
export function configEditorOf(ctx) {
  try {
    const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
    if (editor === undefined || editor === null) return undefined
    if (typeof editor.entries !== 'function' || typeof editor.edit !== 'function') return undefined
    return editor
  } catch {
    return undefined
  }
}

/**
 * The plugin's own addressable row inside the profile composition.
 * @param {{ entries: Function }} editor - config editor.
 * @returns {object | null} the Loader entry, or null when it is not addressable.
 */
export function findConfigEntry(editor) {
  try {
    const entries = editor.entries()
    if (!Array.isArray(entries)) return null
    return entries.find((entry) => entry?.options?.name === name) ?? null
  } catch {
    return null
  }
}

/**
 * The `/settings` handler; a handler route because resources answer GET/HEAD
 * only and this one has to read a POST body.
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   settings: { enabled: boolean, dryRun: boolean, warnAt: number },
 *   logger?: { info?: (message: string) => void, warn?: (message: string) => void },
 * }} input - dependencies; `settings` is mutated in place after a save.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
export function createSettingsHandler({ ctx, settings, logger }) {
  return async function handleSettings(req, res) {
    const reply = (status, body) => {
      if (res.writableEnded === true) return
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    }

    const headers = req?.headers ?? {}
    const host = String(headers.host ?? '').trim()
    if (!LOOPBACK_HOST.test(host)) {
      return reply(403, {
        ok: false,
        error: 'forbidden',
        message: `loopback only (Host: ${host === '' ? '(missing)' : host})`,
      })
    }
    if (String(headers[CLIENT_HEADER] ?? '') !== CLIENT_HEADER_VALUE) {
      return reply(403, { ok: false, error: 'forbidden', message: `missing ${CLIENT_HEADER} request header` })
    }

    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      return reply(405, { ok: false, error: 'method-not-allowed', allow: 'GET, POST' })
    }

    const editor = configEditorOf(ctx)
    if (method === 'GET') {
      return reply(200, { ok: true, editable: editor !== undefined, settings: { ...settings } })
    }

    if (editor === undefined) {
      return reply(501, {
        ok: false,
        editable: false,
        error: 'config-editor-unavailable',
        message: 'this profile provides no configEditor; edit cordis.patch.yml instead',
      })
    }

    try {
      const patch = validateSettingsPatch(await readJsonBody(req))
      const entry = findConfigEntry(editor)
      if (entry === null) {
        return reply(409, {
          ok: false,
          error: 'entry-not-found',
          message: 'the plugin row is not addressable in this profile',
        })
      }
      const next = normalizeSettings({ ...settings, ...patch })
      await editor.edit(entry, () => ({ ...next }))
      Object.assign(settings, next)
      logger?.info?.(
        `dsh-auth-cookie-guard: settings saved (enabled=${String(next.enabled)}, ` +
          `dryRun=${String(next.dryRun)}, warnAt=${String(next.warnAt)})`,
      )
      return reply(200, { ok: true, saved: true, editable: true, settings: { ...next } })
    } catch (error) {
      if (error instanceof SettingsInputError) {
        return reply(400, { ok: false, error: error.code, message: error.message })
      }
      logger?.warn?.(
        `dsh-auth-cookie-guard: settings save failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return reply(500, {
        ok: false,
        error: 'save-failed',
        message: 'the settings could not be persisted; check the Host log',
      })
    }
  }
}

/**
 * Read and parse a small JSON body.
 * @param {AsyncIterable<Buffer>} req - incoming request.
 * @param {number} [limit] - maximum body bytes.
 * @returns {Promise<unknown>} parsed JSON.
 * @throws {SettingsInputError} on oversized, empty or invalid JSON bodies.
 */
export async function readJsonBody(req, limit = MAX_SETTINGS_BODY) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new SettingsInputError('settings body is too large', 'body-too-large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new SettingsInputError('empty settings body', 'empty-patch')
  try {
    return JSON.parse(text)
  } catch {
    throw new SettingsInputError('body must be valid JSON', 'invalid-json')
  }
}

/**
 * Loopback-host and same-origin marker check.
 * @param {Request} request - incoming request.
 * @returns {string | undefined} a human-readable refusal, or undefined to allow.
 */
export function requestFence(request) {
  const host = String(request?.headers?.get?.('host') ?? '').trim()
  if (!LOOPBACK_HOST.test(host)) {
    return `loopback only (Host: ${host === '' ? '(missing)' : host})`
  }
  if (String(request?.headers?.get?.(CLIENT_HEADER) ?? '') !== CLIENT_HEADER_VALUE) {
    return `missing ${CLIENT_HEADER} request header`
  }
  return undefined
}

/**
 * JSON response with optional deletion cookies kept as separate header lines.
 * @param {number} status - HTTP status.
 * @param {Record<string, unknown>} body - JSON body.
 * @param {readonly string[]} [cookieHeaders] - Set-Cookie values.
 * @returns {Response} the response the web server writes out.
 */
export function jsonResponse(status, body, cookieHeaders = []) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  for (const value of cookieHeaders) headers.append('set-cookie', value)
  return new Response(JSON.stringify(body), { status, headers })
}

/** Internal handles for tests. */
export const __internal = {
  ROUTE_PREFIX,
  SETTINGS_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  LOOPBACK_HOST,
  buildSnapshot,
  readOrigin,
  shortenCookieName,
  cookieNameForAuthority,
}
