import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  CLIENT_HEADER,
  ROUTE_PREFIX,
  SETTINGS_PATH,
  apply,
  createHandler,
  jsonResponse,
  requestFence,
} from '../index.js'
import { cookieNameForAuthority, normalizeSettings } from '../core.mjs'

const ORIGIN = 'http://127.0.0.1:5173'
const AUTHORITY = '127.0.0.1:5173'
const CURRENT = cookieNameForAuthority(AUTHORITY)
const STALE = [cookieNameForAuthority('127.0.0.1:4001'), cookieNameForAuthority('127.0.0.1:4002')]
const COOKIE_HEADER = [`theme=dark`, `${CURRENT}=v0`, ...STALE.map((name, index) => `${name}=v${index + 1}`)].join('; ')

/**
 * Minimal request stand-in: the handler only reads url, method and three headers.
 * @param {string} suffix - path after the route prefix, query included.
 * @param {Record<string, string | null>} [headers] - header overrides.
 * @returns {{ url: string, method: string, headers: { get: (name: string) => string | null } }} request stub.
 */
function makeRequest(suffix, headers = {}) {
  const table = {
    host: '127.0.0.1:5173',
    [CLIENT_HEADER]: '1',
    cookie: COOKIE_HEADER,
    ...headers,
  }
  return {
    url: `${ORIGIN}${ROUTE_PREFIX}${suffix}`,
    method: 'GET',
    headers: { get: (name) => (name in table ? table[name] : null) },
  }
}

/** Fresh handler with its own state. */
function makeHandler(config = {}, origin = ORIGIN, logger) {
  const state = { last: null, purges: 0, purgedTotal: 0 }
  const handler = createHandler({
    runtime: { server: { getOrigin: () => origin } },
    settings: normalizeSettings(config),
    state,
    logger,
  })
  return { handler, state }
}

test('GET /status reports the carried cookies and never deletes', async () => {
  const { handler, state } = makeHandler()
  const response = await handler(makeRequest('/status'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.getSetCookie().length, 0)

  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.origin, ORIGIN)
  assert.equal(body.authority, AUTHORITY)
  assert.equal(body.currentName, CURRENT)
  assert.equal(body.currentPresent, true)
  assert.equal(body.carried, 3)
  assert.equal(body.stale, 2)
  assert.ok(body.headerBytes > 0)
  assert.equal(body.risk, 'safe')
  assert.equal(body.settings.enabled, true)
  assert.equal(state.last, null)
})

test('GET /purge expires every stale cookie and keeps the current one', async () => {
  const messages = []
  const { handler, state } = makeHandler({}, ORIGIN, { info: (message) => messages.push(message) })
  const response = await handler(makeRequest('/purge'))
  assert.equal(response.status, 200)

  const cookies = response.headers.getSetCookie()
  assert.equal(cookies.length, 2)
  assert.deepEqual(
    cookies.map((value) => value.slice(0, value.indexOf('='))).sort(),
    [...STALE].sort(),
  )
  for (const value of cookies) {
    assert.match(value, /Max-Age=0/u)
    assert.ok(!value.startsWith(`${CURRENT}=`), 'the current cookie must survive')
  }

  const body = await response.json()
  assert.equal(body.purge.deleted, 2)
  assert.equal(body.purge.dryRun, false)
  assert.equal(body.last.purged, 2)
  assert.equal(state.purges, 1)
  assert.equal(state.purgedTotal, 2)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /expired 2 stale cookies/u)
  assert.ok(!messages[0].includes(CURRENT), 'cookie names stay out of the log')
})

test('dryRun reports the plan without expiring anything', async () => {
  const { handler } = makeHandler({ dryRun: true })
  const response = await handler(makeRequest('/purge'))
  assert.equal(response.headers.getSetCookie().length, 0)
  const body = await response.json()
  assert.equal(body.purge.deleted, 0)
  assert.equal(body.purge.dryRun, true)
  assert.equal(body.stale, 2)
})

test('manual purge works even when automatic pruning is off', async () => {
  const disabled = makeHandler({ enabled: false })
  const automatic = await disabled.handler(makeRequest('/purge'))
  assert.equal((await automatic.json()).purge.allowed, false)
  assert.equal(automatic.headers.getSetCookie().length, 0)

  const manual = await disabled.handler(makeRequest('/purge?manual=1'))
  assert.equal(manual.headers.getSetCookie().length, 2)
  assert.equal((await manual.json()).purge.deleted, 2)

  const dry = makeHandler({ dryRun: true })
  const forced = await dry.handler(makeRequest('/purge?manual=1'))
  assert.equal(forced.headers.getSetCookie().length, 2)
})

test('a missing current cookie aborts the purge instead of signing the page out', async () => {
  const { handler } = makeHandler()
  const response = await handler(makeRequest('/purge', { cookie: STALE.map((name) => `${name}=v`).join('; ') }))
  assert.equal(response.headers.getSetCookie().length, 0)
  const body = await response.json()
  assert.equal(body.skipped, 'current-cookie-missing')
  assert.equal(body.purge.deleted, 0)
})

test('the route is fenced by a loopback Host and a marker header', async () => {
  const { handler } = makeHandler()

  const noMarker = await handler(makeRequest('/status', { [CLIENT_HEADER]: null }))
  assert.equal(noMarker.status, 403)
  assert.equal((await noMarker.json()).error, 'forbidden')

  const rebinding = await handler(makeRequest('/status', { host: 'evil.example' }))
  assert.equal(rebinding.status, 403)

  assert.equal(requestFence(makeRequest('/status')), undefined)
  assert.match(requestFence(makeRequest('/status', { host: '' })), /loopback only/u)
})

test('unknown actions, wrong methods and foreign paths are refused', async () => {
  const { handler } = makeHandler()
  assert.equal((await handler(makeRequest('/nope'))).status, 404)

  const post = await handler({ ...makeRequest('/purge'), method: 'POST' })
  assert.equal(post.status, 405)

  const foreign = await handler({ ...makeRequest('/purge'), url: `${ORIGIN}/api/something-else` })
  assert.equal(foreign.status, 404)
})

test('a server without a bound origin degrades to an empty plan', async () => {
  const state = { last: null, purges: 0, purgedTotal: 0 }
  const handler = createHandler({
    runtime: {
      server: {
        getOrigin: () => {
          throw new Error('not listening')
        },
      },
    },
    settings: normalizeSettings({}),
    state,
  })
  const response = await handler(makeRequest('/status'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.origin, null)
  assert.equal(body.skipped, 'unknown-authority')
  assert.equal(body.carried, 0)
})

test('jsonResponse keeps each deletion cookie on its own line', async () => {
  const response = jsonResponse(200, { ok: true }, ['a=; Max-Age=0; Path=/', 'b=; Max-Age=0; Path=/'])
  assert.equal(response.status, 200)
  assert.deepEqual(response.headers.getSetCookie(), ['a=; Max-Age=0; Path=/', 'b=; Max-Age=0; Path=/'])
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('apply registers a resource route and an exact settings handler', () => {
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    inject: (dependencies, callback) => {
      callback({
        webServer: {
          getOrigin: () => ORIGIN,
          register: (route) => {
            registered.push(route)
            return () => {}
          },
        },
        effect: (fn) => {
          fn()
          return () => {}
        },
      })
    },
  }

  apply(ctx, {})

  assert.equal(registered.length, 2)

  const resourceRoute = registered.find((route) => route.kind === 'prefix')
  assert.equal(resourceRoute.path, ROUTE_PREFIX)
  assert.equal(typeof resourceRoute.resource, 'function')
  // A handler route is called as (req, res) and must end the response itself;
  // returning a Response there leaves the socket open forever.
  assert.equal(resourceRoute.handler, undefined)

  const settingsRoute = registered.find((route) => route.kind === 'exact')
  assert.equal(settingsRoute.path, SETTINGS_PATH)
  assert.equal(typeof settingsRoute.handler, 'function')
  // Resources answer GET/HEAD only, so the POST settings write needs a handler.
  assert.equal(settingsRoute.resource, undefined)
})

test('the resource answers a real HTTP request with deletion headers', async () => {
  const { handler } = makeHandler()
  const server = createServer(async (req, res) => {
    const target = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers.set(name, value.join(', '))
      else if (value !== undefined) headers.set(name, value)
    }
    const response = await handler(new Request(target, { headers }))
    const outgoing = Object.fromEntries(response.headers)
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 0) outgoing['set-cookie'] = cookies
    res.writeHead(response.status, outgoing)
    res.end(await response.text())
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}${ROUTE_PREFIX}/purge`, {
      headers: { [CLIENT_HEADER]: '1', cookie: COOKIE_HEADER },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.getSetCookie().length, 2)
    const body = await response.json()
    assert.equal(body.purge.deleted, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
