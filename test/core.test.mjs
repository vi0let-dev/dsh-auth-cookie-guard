import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  COOKIE_NAME_RE,
  COOKIE_PREFIX,
  DEFAULT_SETTINGS,
  EDITABLE_SETTING_KEYS,
  HEADER_BUDGET_BYTES,
  MAX_PURGE_PER_RESPONSE,
  SettingsInputError,
  authorityFromOrigin,
  cookieNameForAuthority,
  estimateHeaderBytes,
  listAuthCookies,
  normalizeSettings,
  parseCookieHeader,
  planPurge,
  riskOf,
  serializeExpiredCookie,
  validateSettingsPatch,
} from '../core.mjs'

const ORIGIN = 'http://127.0.0.1:5173'
const AUTHORITY = '127.0.0.1:5173'

/** Independent implementation of the Host's spelling, so a refactor cannot drift silently. */
function expectedName(authority) {
  return `dsh-auth-${createHash('sha256')
    .update(authority)
    .digest('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')}`
}

test('cookie name matches the Host spelling', () => {
  const name = cookieNameForAuthority(AUTHORITY)
  assert.equal(name, expectedName(AUTHORITY))
  assert.match(name, COOKIE_NAME_RE)
  assert.equal(name.length, COOKIE_PREFIX.length + 43)
})

test('a different port produces a different cookie name', () => {
  assert.notEqual(cookieNameForAuthority('127.0.0.1:5173'), cookieNameForAuthority('127.0.0.1:5174'))
})

test('authorityFromOrigin keeps the port and rejects garbage', () => {
  assert.equal(authorityFromOrigin(ORIGIN), AUTHORITY)
  assert.equal(authorityFromOrigin('https://127.0.0.1'), '127.0.0.1')
  assert.equal(authorityFromOrigin('not a url'), undefined)
  assert.equal(authorityFromOrigin(''), undefined)
  assert.equal(authorityFromOrigin(undefined), undefined)
})

test('parseCookieHeader skips empty and malformed segments', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=2; c=; ; =x; d'), [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
    { name: 'c', value: '' },
  ])
  assert.deepEqual(parseCookieHeader(undefined), [])
  assert.deepEqual(parseCookieHeader(''), [])
})

test('listAuthCookies keeps only generated names', () => {
  const current = cookieNameForAuthority(AUTHORITY)
  const header = `theme=dark; ${current}=abc; dsh-auth-short=1; other=${current}`
  assert.deepEqual(
    listAuthCookies(header).map((cookie) => cookie.name),
    [current],
  )
})

test('estimateHeaderBytes counts separators', () => {
  assert.equal(estimateHeaderBytes([]), 0)
  assert.equal(
    estimateHeaderBytes([
      { name: 'a', value: '1' },
      { name: 'b', value: '22' },
    ]),
    3 + 4 + 2,
  )
})

test('planPurge keeps the current cookie and expires the rest', () => {
  const current = cookieNameForAuthority(AUTHORITY)
  const staleA = cookieNameForAuthority('127.0.0.1:4001')
  const staleB = cookieNameForAuthority('127.0.0.1:4002')
  const cookieHeader = [`theme=dark`, `${current}=v0`, `${staleA}=v1`, `${staleB}=v2`].join('; ')

  const plan = planPurge({ cookieHeader, origin: ORIGIN })
  assert.equal(plan.authority, AUTHORITY)
  assert.equal(plan.currentName, current)
  assert.equal(plan.currentPresent, true)
  assert.equal(plan.carriedCount, 3)
  assert.equal(plan.staleCount, 2)
  assert.deepEqual(plan.purge, [staleA, staleB])
  assert.equal(plan.truncated, false)
  assert.equal(plan.skipped, null)
  assert.ok(plan.headerBytes > 0)
})

test('planPurge refuses when the current cookie is absent', () => {
  const staleA = cookieNameForAuthority('127.0.0.1:4001')
  const plan = planPurge({ cookieHeader: `${staleA}=v1`, origin: ORIGIN })
  assert.equal(plan.currentPresent, false)
  assert.equal(plan.carriedCount, 1)
  assert.deepEqual(plan.purge, [])
  assert.equal(plan.skipped, 'current-cookie-missing')
})

test('planPurge is empty without auth cookies', () => {
  const plan = planPurge({ cookieHeader: 'theme=dark', origin: ORIGIN })
  assert.equal(plan.carriedCount, 0)
  assert.equal(plan.headerBytes, 0)
  assert.deepEqual(plan.purge, [])
  assert.equal(plan.skipped, null)
})

test('planPurge reports an unknown origin instead of throwing', () => {
  const plan = planPurge({ cookieHeader: '', origin: 'nonsense' })
  assert.equal(plan.authority, null)
  assert.equal(plan.skipped, 'unknown-authority')
})

test('planPurge caps one response and flags truncation', () => {
  const current = cookieNameForAuthority(AUTHORITY)
  const stale = ['a', 'b', 'c'].map((tag) => cookieNameForAuthority(`127.0.0.1:${tag}`))
  const cookieHeader = [current, ...stale].map((name, index) => `${name}=v${index}`).join('; ')

  const plan = planPurge({ cookieHeader, origin: ORIGIN, maxPurge: 2 })
  assert.equal(plan.purge.length, 2)
  assert.equal(plan.staleCount, 3)
  assert.equal(plan.truncated, true)
  assert.ok(plan.purge.length <= MAX_PURGE_PER_RESPONSE)
})

test('one deletion cookie is same-name, root-path and already expired', () => {
  const name = cookieNameForAuthority(AUTHORITY)
  const value = serializeExpiredCookie(name)
  assert.ok(value.startsWith(`${name}=;`))
  assert.match(value, /Max-Age=0/u)
  assert.match(value, /Path=\//u)
  assert.match(value, /Expires=Thu, 01 Jan 1970/u)
  assert.match(value, /HttpOnly/u)
  assert.match(value, /SameSite=Strict/u)
})

test('riskOf follows the count and the byte budget', () => {
  assert.equal(riskOf({ carriedCount: 1, headerBytes: 200 }), 'safe')
  assert.equal(riskOf({ carriedCount: 5, headerBytes: 9000 }), 'warn')
  assert.equal(riskOf({ carriedCount: 40, headerBytes: 200 }), 'warn')
  assert.equal(riskOf({ carriedCount: 70, headerBytes: 200 }), 'danger')
  assert.equal(riskOf({ carriedCount: 2, headerBytes: HEADER_BUDGET_BYTES }), 'danger')
  assert.equal(riskOf({ carriedCount: 10, headerBytes: 100, warnAt: 5 }), 'warn')
})

test('normalizeSettings fills defaults and drops invalid values', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ enabled: false, dryRun: true, warnAt: 12 }), {
    enabled: false,
    dryRun: true,
    warnAt: 12,
  })
  assert.equal(normalizeSettings({ warnAt: 0 }).warnAt, DEFAULT_SETTINGS.warnAt)
  assert.equal(normalizeSettings({ warnAt: 501 }).warnAt, DEFAULT_SETTINGS.warnAt)
  assert.equal(normalizeSettings({ warnAt: 12.5 }).warnAt, DEFAULT_SETTINGS.warnAt)
  assert.equal(normalizeSettings({ enabled: 'no' }).enabled, true)
})

test('validateSettingsPatch accepts exactly the three editable keys', () => {
  assert.deepEqual([...EDITABLE_SETTING_KEYS].sort(), ['dryRun', 'enabled', 'warnAt'])
  assert.deepEqual(validateSettingsPatch({ enabled: false }), { enabled: false })
  assert.deepEqual(validateSettingsPatch({ enabled: true, dryRun: true, warnAt: 40 }), {
    enabled: true,
    dryRun: true,
    warnAt: 40,
  })
})

test('validateSettingsPatch refuses unknown keys', () => {
  assert.throws(
    () => validateSettingsPatch({ enabled: true, home: '/tmp' }),
    (error) => error instanceof SettingsInputError && error.code === 'unknown-setting',
  )
})

test('validateSettingsPatch type-checks booleans and the threshold', () => {
  for (const body of [{ enabled: 'yes' }, { dryRun: 1 }, { warnAt: '10' }, { warnAt: 0 }, { warnAt: 501 }, { warnAt: 1.5 }]) {
    assert.throws(
      () => validateSettingsPatch(body),
      (error) => error instanceof SettingsInputError && error.code.startsWith('invalid-'),
    )
  }
})

test('validateSettingsPatch refuses non-object and empty payloads', () => {
  for (const body of [null, [], {}, 'x', 42]) {
    assert.throws(
      () => validateSettingsPatch(body),
      (error) => error instanceof SettingsInputError,
    )
  }
})
