import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { CLIENT_HEADER, SETTINGS_PATH, createSettingsHandler, findConfigEntry } from '../index.js'
import { normalizeSettings } from '../core.mjs'

const START = { enabled: true, dryRun: false, warnAt: 40 }

/**
 * Request stand-in: a readable body plus the three headers the handler reads.
 * @param {{ method?: string, body?: string, headers?: Record<string, string> }} [input] - request shape.
 * @returns {import('node:stream').Readable} the fake request.
 */
function makeRequest(input = {}) {
  const req = Readable.from(input.body === undefined ? [] : [Buffer.from(input.body)])
  req.method = input.method ?? 'GET'
  req.url = SETTINGS_PATH
  req.headers = {
    host: '127.0.0.1:9775',
    [CLIENT_HEADER]: '1',
    ...(input.headers ?? {}),
  }
  return req
}

/** Response stand-in that records status, headers and payload. */
function makeResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    status: 0,
    headers: null,
    payload: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(payload) {
      this.payload = payload ?? ''
      this.writableEnded = true
    },
    json() {
      return JSON.parse(this.payload)
    },
  }
}

/**
 * Editor stub: records the derived config and resolves immediately.
 * @param {{ fail?: Error }} [options] - make `edit` reject.
 * @returns {{ entry: object, calls: any[], entries: Function, edit: Function }} fake editor.
 */
function makeEditor(options = {}) {
  const entry = { options: { id: 'dsh-auth-cookie-guard', name: 'dsh-auth-cookie-guard', config: { ...START } } }
  const calls = []
  return {
    entry,
    calls,
    entries: () => [entry],
    edit: async (target, change) => {
      calls.push({ target, next: change(target.options.config, {}) })
      if (options.fail !== undefined) throw options.fail
    },
  }
}

/**
 * Run one request against a fresh handler.
 * @param {{ editor?: object, request?: object, settings?: object }} [input] - overrides.
 * @returns {Promise<{ res: any, settings: object, editor?: any }>} outcome.
 */
async function run(input = {}) {
  const settings = normalizeSettings(input.settings ?? START)
  const editor = input.editor
  const ctx = { get: (key) => (key === 'configEditor' ? editor : undefined) }
  const handler = createSettingsHandler({ ctx, settings, logger: { info() {}, warn() {} } })
  const res = makeResponse()
  await handler(makeRequest(input.request ?? {}), res)
  return { res, settings, editor }
}

test('GET reports the effective settings and whether saving is possible', async () => {
  const editor = makeEditor()
  const { res } = await run({ editor })
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.editable, true)
  assert.deepEqual(body.settings, START)
})

test('GET without a config editor reports editable=false', async () => {
  const { res } = await run({})
  assert.equal(res.status, 200)
  assert.equal(res.json().editable, false)
})

test('POST validates and persists a full settings patch', async () => {
  const editor = makeEditor()
  const { res, settings } = await run({
    editor,
    request: { method: 'POST', body: JSON.stringify({ enabled: false, dryRun: true, warnAt: 12 }) },
  })

  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.saved, true)
  assert.deepEqual(body.settings, { enabled: false, dryRun: true, warnAt: 12 })
  assert.equal(editor.calls.length, 1)
  assert.deepEqual(editor.calls[0].next, { enabled: false, dryRun: true, warnAt: 12 })
  // The in-memory settings object is mutated so later requests see the change.
  assert.deepEqual(settings, { enabled: false, dryRun: true, warnAt: 12 })
})

test('the shipped defaults are accepted as an explicit patch', async () => {
  const editor = makeEditor()
  const { res, settings } = await run({
    editor,
    request: { method: 'POST', body: JSON.stringify({ enabled: true, dryRun: false, warnAt: 40 }) },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(settings, START)
  assert.deepEqual(editor.calls[0].next, START)
})

test('POST rejects an unknown key', async () => {
  const editor = makeEditor()
  const { res } = await run({
    editor,
    request: { method: 'POST', body: JSON.stringify({ enabled: true, command: 'rm -rf /' }) },
  })
  assert.equal(res.status, 400)
  assert.equal(res.json().error, 'unknown-setting')
  assert.equal(editor.calls.length, 0)
})

test('POST rejects an out-of-range threshold', async () => {
  const editor = makeEditor()
  const { res } = await run({
    editor,
    request: { method: 'POST', body: JSON.stringify({ warnAt: 501 }) },
  })
  assert.equal(res.status, 400)
  assert.equal(res.json().error, 'invalid-warn-at')
})

test('POST rejects malformed JSON', async () => {
  const editor = makeEditor()
  const { res } = await run({
    editor,
    request: { method: 'POST', body: '{"enabled":' },
  })
  assert.equal(res.status, 400)
  assert.equal(res.json().error, 'invalid-json')
})

test('POST answers 501 when the profile has no config editor', async () => {
  const { res, settings } = await run({
    request: { method: 'POST', body: JSON.stringify({ enabled: false }) },
  })
  assert.equal(res.status, 501)
  assert.equal(res.json().error, 'config-editor-unavailable')
  assert.deepEqual(settings, START)
})

test('a failing editor keeps the old settings and answers 500', async () => {
  const editor = makeEditor({ fail: new Error('lock timeout') })
  const { res, settings } = await run({
    editor,
    request: { method: 'POST', body: JSON.stringify({ enabled: false }) },
  })
  assert.equal(res.status, 500)
  assert.equal(res.json().error, 'save-failed')
  assert.deepEqual(settings, START)
})

test('the settings route is fenced like the rest', async () => {
  const editor = makeEditor()

  const noMarker = await run({
    editor,
    request: { headers: { [CLIENT_HEADER]: '' } },
  })
  assert.equal(noMarker.res.status, 403)

  const rebinding = await run({ editor, request: { headers: { host: 'evil.example' } } })
  assert.equal(rebinding.res.status, 403)
})

test('unsupported methods are refused', async () => {
  const editor = makeEditor()
  const { res } = await run({ editor, request: { method: 'PUT' } })
  assert.equal(res.status, 405)
  assert.equal(res.json().allow, 'GET, POST')
})

test('findConfigEntry matches the plugin row by package name', () => {
  const editor = makeEditor()
  assert.equal(findConfigEntry(editor), editor.entry)
  assert.equal(findConfigEntry({ entries: () => [] }), null)
  assert.equal(findConfigEntry({ entries: () => { throw new Error('gone') } }), null)
})
