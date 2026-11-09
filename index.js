/**
 * dsh-auth-cookie-guard — Host half.
 *
 * Serves one same-origin route under `/api/dsh-auth-cookie-guard`:
 *
 *   GET /status   report what the current request carried; never deletes.
 *   GET /purge    expire every stale generated cookie, keep the current one.
 *
 * Why a route and not a cleanup job: the Desktop Host is a plain Node child of
 * Electron, so it cannot reach Chromium's cookie jar (the Cookies database is
 * even exclusively locked while the app runs). The browser, however, applies a
 * `Set-Cookie: <name>=; Max-Age=0` from any same-origin response — that is the
 * one supported way to remove an HttpOnly cookie from the jar without touching
 * the profile on disk.
 *
 * Safety rules:
 *   - Loopback `Host` plus a custom request header fence the route against
 *     DNS-rebinding and cross-site requests.
 *   - Only cookies shaped like a generated `dsh-auth-<digest>` name are touched.
 *   - The cookie of the authority serving the request is always kept; when it
 *     is absent the plan is abandoned rather than risk logging the page out.
 *   - Nothing is read besides the request headers; no file, no network.
 *
 * @module index.js
 */

import {
  HEADER_BUDGET_BYTES,
  cookieNameForAuthority,
  normalizeSettings,
  planPurge,
  riskOf,
  serializeExpiredCookie,
} from './core.mjs'

export const name = 'dsh-auth-cookie-guard'

/**
 * No hard service dependency: the profile may be a non-Web one, where the
 * plugin simply stays inactive. `ctx.inject` waits for the web server instead.
 */
export const inject = []

/** Longest-prefix route; the connection RPC guard owns the shorter `/api`. */
export const ROUTE_PREFIX = '/api/dsh-auth-cookie-guard'

/** Same-origin marker header; a cross-site form cannot set it. */
export const CLIENT_HEADER = 'x-dsh-auth-cookie-guard'
export const CLIENT_HEADER_VALUE = '1'

/**
 * The Host header must be a loopback literal. This blocks DNS-rebinding
 * requests whose Origin is an attacker-controlled domain resolving to 127.0.0.1.
 */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d{1,5})?$/i

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const settings = normalizeSettings(config)
  const state = { last: null, purges: 0, purgedTotal: 0 }
  const runtime = { server: undefined }
  const handler = createHandler({ runtime, settings, state, logger: ctx.logger })

  // webServer is published by the browser composition, which may activate
  // after this plugin; ctx.inject waits for it and re-registers if replaced.
  ctx.inject(['webServer'], (scoped) => {
    const server =
      scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer') : undefined)
    if (server === undefined || server === null || typeof server.register !== 'function') return
    runtime.server = server
    scoped.effect(
      () => server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-auth-cookie-guard: routes',
    )
  })
}

/**
 * Build the route handler. Exported for tests, which pass a stub runtime.
 * @param {{
 *   runtime: { server?: { getOrigin?: () => string } },
 *   settings: { enabled: boolean, dryRun: boolean, warnAt: number },
 *   state: { last: object | null, purges: number, purgedTotal: number },
 *   logger?: { info?: (message: string) => void },
 *   now?: () => Date,
 * }} input - handler dependencies.
 * @returns {(request: Request) => Promise<Response>} the resource handler.
 */
export function createHandler({ runtime, settings, state, logger, now = () => new Date() }) {
  return async function handle(request) {
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
      return jsonResponse(200, buildSnapshot({ origin, plan, settings, state, at }))
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

    const snapshot = buildSnapshot({ origin, plan, settings, state, at })
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
 * }} input - observed values.
 * @returns {Record<string, unknown>} JSON-safe snapshot.
 */
function buildSnapshot({ origin, plan, settings, state, at }) {
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
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  LOOPBACK_HOST,
  buildSnapshot,
  readOrigin,
  shortenCookieName,
  cookieNameForAuthority,
}
