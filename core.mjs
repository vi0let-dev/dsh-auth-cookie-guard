/**
 * dsh-auth-cookie-guard — pure helpers shared by the Host half and the tests.
 *
 * Nothing here touches the filesystem, the network, or a DSH service, so every
 * rule that decides which cookies get expired is testable in isolation.
 *
 * Background: the Desktop Host binds a new random loopback port on each launch,
 * and the connection plugin names its browser-session cookie after the request
 * authority (`dsh-auth-` + base64url(sha256("host:port"))). Chromium stores
 * cookies per host, not per port, so each launch adds one more cookie for
 * `127.0.0.1` and the Cookie request header keeps growing until the HTTP parser
 * rejects it. The only place a running Host can remove them is a response: a
 * `Set-Cookie` with `Max-Age=0` deletes the cookie in the browser's jar.
 *
 * @module core.mjs
 */

import { createHash } from 'node:crypto'

/** Prefix used by the Host connection's browser-session cookie. */
export const COOKIE_PREFIX = 'dsh-auth-'

/**
 * Exact shape of a generated cookie name: the prefix plus the 43-character
 * base64url digest of a 32-byte SHA-256. Matching the shape (instead of only
 * the prefix) keeps unrelated `dsh-auth-*` lookalikes out of the purge plan.
 */
export const COOKIE_NAME_RE = /^dsh-auth-[A-Za-z0-9_-]{43}$/u

/**
 * Header budget the failure is about. Node's HTTP parser defaults to a 16 KiB
 * request-header limit, and an oversized Cookie header is answered with 431
 * before any application code runs.
 */
export const HEADER_BUDGET_BYTES = 16 * 1024

/** A Cookie header this large is a launch failure waiting to happen. */
export const DANGER_HEADER_BYTES = 14 * 1024

/** A Cookie header this large means the next launches are at risk. */
export const WARN_HEADER_BYTES = 8 * 1024

/** Cookies per host Chromium keeps at most; also a sane cap for one response. */
export const MAX_PURGE_PER_RESPONSE = 180

/** Default number of carried auth cookies at which the UI starts warning. */
export const DEFAULT_WARN_AT = 40

/** Default settings for a profile that never edited the patch. */
export const DEFAULT_SETTINGS = Object.freeze({ enabled: true, dryRun: false, warnAt: DEFAULT_WARN_AT })

/**
 * Encode bytes as base64url without padding — the same spelling the Host uses
 * for the cookie name.
 * @param {Buffer | string} value - bytes, or text to encode as UTF-8.
 * @returns {string} base64url text.
 */
export function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/**
 * Name of the browser-session cookie for one authority.
 * @param {string} authority - `host:port` for http, the URL origin for https.
 * @returns {string} the generated cookie name.
 */
export function cookieNameForAuthority(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/**
 * The authority the Host cookie was minted for.
 * @param {string} origin - for example `http://127.0.0.1:13708`.
 * @returns {string | undefined} `url.host`, or undefined when the origin is invalid.
 */
export function authorityFromOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return undefined
  try {
    return new URL(origin).host || undefined
  } catch {
    return undefined
  }
}

/**
 * Decode a Cookie request header into ordered name/value pairs.
 * @param {string | undefined} header - raw Cookie header.
 * @returns {Array<{ name: string, value: string }>} pairs in header order.
 */
export function parseCookieHeader(header) {
  if (typeof header !== 'string' || header.length === 0) return []
  const pairs = []
  for (const segment of header.split(';')) {
    const text = segment.trim()
    if (text.length === 0) continue
    const at = text.indexOf('=')
    if (at <= 0) continue
    const name = text.slice(0, at).trim()
    if (name.length === 0) continue
    pairs.push({ name, value: text.slice(at + 1).trim() })
  }
  return pairs
}

/**
 * Only the generated browser-session cookies out of one Cookie header.
 * @param {string | undefined} header - raw Cookie header.
 * @returns {Array<{ name: string, value: string }>} generated auth cookies.
 */
export function listAuthCookies(header) {
  return parseCookieHeader(header).filter((pair) => COOKIE_NAME_RE.test(pair.name))
}

/**
 * Bytes one Cookie header spends on the given cookies, separators included.
 * @param {ReadonlyArray<{ name: string, value: string }>} cookies - cookies that would be sent.
 * @returns {number} byte count of `name=value; name=value`.
 */
export function estimateHeaderBytes(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return 0
  let bytes = 0
  for (const cookie of cookies) {
    bytes += cookie.name.length + 1 + cookie.value.length
  }
  return bytes + (cookies.length - 1) * 2
}

/**
 * Decide which cookies may be expired without logging the current page out.
 *
 * Only cookies shaped like a generated name are considered, the cookie of the
 * authority serving this request is always kept, and the plan is dropped when
 * that cookie is missing from the request — in that case the request may have
 * authenticated some other way and deleting the rest could break the session.
 *
 * @param {{ cookieHeader?: string, origin: string, maxPurge?: number }} input - one request plus its origin.
 * @returns {{
 *   authority: string | null,
 *   currentName: string | null,
 *   currentPresent: boolean,
 *   carriedCount: number,
 *   headerBytes: number,
 *   staleCount: number,
 *   purge: string[],
 *   truncated: boolean,
 *   skipped: null | 'unknown-authority' | 'current-cookie-missing',
 * }} the purge plan.
 */
export function planPurge(input) {
  const origin = input?.origin
  const maxPurge =
    Number.isInteger(input?.maxPurge) && input.maxPurge > 0 ? input.maxPurge : MAX_PURGE_PER_RESPONSE
  const authority = authorityFromOrigin(origin)
  if (authority === undefined) {
    return emptyPlan(null, null, 'unknown-authority')
  }

  const currentName = cookieNameForAuthority(authority)
  const carried = listAuthCookies(input?.cookieHeader)
  const headerBytes = estimateHeaderBytes(carried)
  const currentPresent = carried.some((cookie) => cookie.name === currentName)
  const staleNames = carried.filter((cookie) => cookie.name !== currentName).map((cookie) => cookie.name)

  if (carried.length === 0) {
    return {
      authority,
      currentName,
      currentPresent: false,
      carriedCount: 0,
      headerBytes: 0,
      staleCount: 0,
      purge: [],
      truncated: false,
      skipped: null,
    }
  }

  if (!currentPresent) {
    return {
      authority,
      currentName,
      currentPresent: false,
      carriedCount: carried.length,
      headerBytes,
      staleCount: staleNames.length,
      purge: [],
      truncated: false,
      skipped: 'current-cookie-missing',
    }
  }

  const purge = staleNames.slice(0, maxPurge)
  return {
    authority,
    currentName,
    currentPresent: true,
    carriedCount: carried.length,
    headerBytes,
    staleCount: staleNames.length,
    purge,
    truncated: staleNames.length > purge.length,
    skipped: null,
  }
}

/**
 * The empty plan used before the origin is known.
 * @param {string | null} authority - resolved authority, if any.
 * @param {string | null} currentName - expected cookie name, if any.
 * @param {null | 'unknown-authority'} skipped - why nothing can be planned.
 * @returns {ReturnType<typeof planPurge>} an empty plan.
 */
function emptyPlan(authority, currentName, skipped) {
  return {
    authority,
    currentName,
    currentPresent: false,
    carriedCount: 0,
    headerBytes: 0,
    staleCount: 0,
    purge: [],
    truncated: false,
    skipped,
  }
}

/**
 * One deletion cookie: same name, same path, already expired. Attributes used
 * only for matching (domain, path) are kept identical to the minted cookie, so
 * Chromium removes the entry instead of adding another one.
 * @param {string} name - generated cookie name.
 * @returns {string} a Set-Cookie header value.
 */
export function serializeExpiredCookie(name) {
  return `${name}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict`
}

/**
 * Risk of the next launch, given what the jar carried this time.
 * @param {{ carriedCount: number, headerBytes: number, warnAt?: number }} input - observed size.
 * @returns {'safe' | 'warn' | 'danger'} risk level.
 */
export function riskOf(input) {
  const carriedCount = Number.isFinite(input?.carriedCount) ? input.carriedCount : 0
  const headerBytes = Number.isFinite(input?.headerBytes) ? input.headerBytes : 0
  const warnAt = Number.isInteger(input?.warnAt) && input.warnAt > 0 ? input.warnAt : DEFAULT_WARN_AT
  if (carriedCount >= 70 || headerBytes >= DANGER_HEADER_BYTES) return 'danger'
  if (carriedCount >= warnAt || headerBytes >= WARN_HEADER_BYTES) return 'warn'
  return 'safe'
}

/**
 * Normalize the row config written in `cordis.patch.yml`.
 * Invalid values fall back to the safe defaults instead of failing activation.
 * @param {unknown} raw - config object from the Loader.
 * @returns {{ enabled: boolean, dryRun: boolean, warnAt: number }} effective settings.
 */
export function normalizeSettings(raw) {
  const record = raw !== null && typeof raw === 'object' ? raw : {}
  const enabled = record.enabled !== false
  const dryRun = record.dryRun === true
  const warnAt =
    Number.isInteger(record.warnAt) && record.warnAt > 0 && record.warnAt <= 500
      ? record.warnAt
      : DEFAULT_WARN_AT
  return { enabled, dryRun, warnAt }
}

/** Internal handles for tests. */
export const __internal = {
  emptyPlan,
}
