import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
const PLUGIN_ID = 'dsh-auth-cookie-guard'
const API = '/api/dsh-auth-cookie-guard'

/**
 * Minimal React stand-in: enough to build element trees without a renderer.
 * @returns {Record<string, unknown>} React-like module.
 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (factory) => factory(),
  }
}

/**
 * Run client.js in a sandbox and return the captured module plus its fetch log.
 * @returns {{ module: any, calls: Array<{ url: string, init: any }> }} captured values.
 */
function loadModule() {
  let captured
  const calls = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => (captured = definition) } },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({
        setAttribute: () => {},
        remove: () => {},
        style: {},
        textContent: '',
      }),
    },
    fetch: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ ok: true, risk: 'safe', purge: { deleted: 0 } }) }
    },
    console,
    setTimeout,
    clearTimeout,
    URL,
  }
  vm.runInNewContext(SOURCE, sandbox)
  assert.ok(captured, 'client.js must call __ModuleLoader__.load exactly once')
  const module = captured.factory((name) => {
    if (name === 'react') return reactStub()
    throw new Error(`unexpected require: ${name}`)
  })
  return { module, calls }
}

/**
 * Collect what apply() registered.
 * @returns {{ effects: string[], locales: any[], slots: any[], ctx: any }} registration log.
 */
function makeContext() {
  const effects = []
  const locales = []
  const slots = []
  const ctx = {
    locale: {
      register: (namespace, dictionaries) => {
        locales.push({ namespace, dictionaries })
        return () => {}
      },
      bind: (namespace) => (key) => key,
    },
    effect: (fn, label) => {
      effects.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (registration, component) => {
        slots.push({ registration, component })
        return () => {}
      },
    },
  }
  return { effects, locales, slots, ctx }
}

test('the module id matches the package name', () => {
  let captured
  vm.runInNewContext(SOURCE, {
    window: { __ModuleLoader__: { load: (definition) => (captured = definition) } },
    document: { head: null, createElement: () => ({}) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
    URL,
  })
  assert.equal(captured.id, PLUGIN_ID)
})

test('apply registers the dictionary, the styles, one boot purge and one settings section', async () => {
  const { module, calls } = loadModule()
  const { effects, locales, slots, ctx } = makeContext()

  module.apply(ctx)

  assert.deepEqual([...module.inject], ['slots', 'locale'])
  assert.equal(locales.length, 1)
  assert.equal(locales[0].namespace, 'dshAuthCookieGuard')
  assert.ok(locales[0].dictionaries.zh && locales[0].dictionaries.en)

  assert.ok(effects.some((label) => label === 'dsh-auth-cookie-guard: styles'))
  assert.ok(effects.some((label) => label === 'dsh-auth-cookie-guard: boot purge'))

  assert.equal(slots.length, 1)
  const { registration, component } = slots[0]
  assert.equal(registration.name, 'settings.section')
  assert.equal(registration.id, PLUGIN_ID)
  assert.equal(registration.order, 42)
  assert.equal(registration.label(), 'nav')
  assert.equal(typeof component, 'function')

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/purge`)
  assert.equal(calls[0].init?.headers?.['x-dsh-auth-cookie-guard'], '1')
  assert.equal(calls[0].init?.credentials, 'same-origin')
})

test('the section renders a stable shell before the first status reply', () => {
  const { module } = loadModule()
  const { slots, ctx } = makeContext()
  module.apply(ctx)

  const wrapper = slots[0].component
  assert.equal(typeof wrapper, 'function')
  const element = wrapper({ t: (key) => key })
  assert.equal(typeof element.type, 'function')
  const page = element.type(element.props)
  assert.equal(page.type, 'div')
  assert.ok(Array.isArray(page.children) && page.children.length > 0)
})

test('a failed boot purge never rejects', async () => {
  let captured
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => (captured = definition) } },
    document: { head: { appendChild: () => {} }, createElement: () => ({ setAttribute() {}, remove() {}, style: {} }) },
    fetch: async () => {
      throw new Error('route missing')
    },
    console,
    setTimeout,
    clearTimeout,
    URL,
  }
  vm.runInNewContext(SOURCE, sandbox)
  const module = captured.factory(() => reactStub())
  const { ctx } = makeContext()

  assert.doesNotThrow(() => module.apply(ctx))
  await new Promise((resolve) => setTimeout(resolve, 0))
})
