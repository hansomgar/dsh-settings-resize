// Regression test for the post-restart failure: the row came up in English and could not
// be switched back to Chinese.
//
// Cause: this plugin declared only `inject: ['slots']`, so on a cold page it could apply
// before the locale service existed. `ctx.get('locale')` then returned undefined, the
// dictionaries were never registered, and the row rendered through a dictionary-less `t`
// — raw keys on screen, or English once only `en` resolved.
//
// The contract asserted here is the fix: `locale` is a hard dependency, and `apply` reads
// `ctx.locale` rather than probing with `ctx.get`.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8')

const mods = []
const sandbox = {
  console,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: {
    documentElement: { style: { setProperty() {}, removeProperty() {} } },
    head: { append() {} },
    createElement: () => ({ id: '', textContent: '', remove() {} }),
  },
  __ModuleLoader__: { load: (m) => mods.push(m) },
}
sandbox.window = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}

const exported = mods[0].factory(() => React)

const failed = []
const check = (label, ok, detail) => {
  if (!ok) failed.push(label)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

// --- 1. the declared dependency contract ------------------------------------------
check('declares locale as a hard dependency', exported.inject.includes('locale'), JSON.stringify(exported.inject))
check('still declares slots', exported.inject.includes('slots'), JSON.stringify(exported.inject))

// --- 2. apply must not probe for the service --------------------------------------
// A `ctx.get('locale')` probe is what silently produced the cold-start failure.
const body = source.slice(source.indexOf('function apply(ctx)'))
const applySource = body.slice(0, body.indexOf('\n    }'))
check(
  'apply reads ctx.locale instead of probing ctx.get',
  applySource.includes('ctx.locale') && !applySource.includes("ctx.get('locale')"),
  applySource.includes("ctx.get('locale')") ? 'still probes ctx.get' : 'ok',
)

// --- 3. a live service produces Chinese on the first paint ------------------------
const dicts = new Map()
const listeners = new Set()
let snapshot = Object.freeze({ active: 'zh', locales: [], revision: 0 })
const publish = (active) => {
  snapshot = Object.freeze({ active, locales: [], revision: snapshot.revision + 1 })
  for (const fn of [...listeners]) fn()
}
const service = {
  getSnapshot: () => snapshot,
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  setLocale(id) {
    if (snapshot.active !== id) publish(id)
  },
  register(ns, d) {
    if (dicts.has(ns)) throw new Error(`locale namespace "${ns}" already has locale "zh"`)
    dicts.set(ns, new Map(Object.entries(d)))
    publish(snapshot.active)
    return () => {
      dicts.delete(ns)
      publish(snapshot.active)
    }
  },
  bind(ns) {
    return (key, params) => {
      const per = dicts.get(ns)
      const chain = snapshot.active === 'zh' ? ['zh', 'en'] : ['en']
      let template
      for (const l of chain) {
        const v = per?.get(l)?.[key]
        if (v !== undefined) {
          template = v
          break
        }
      }
      if (template === undefined) template = key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
    }
  },
}

let registration
const ctx = {
  effect: (fn) => fn(),
  // Present from the first moment, which is what the dependency now guarantees.
  get locale() {
    return service
  },
  get: () => undefined,
  slots: {
    inject: (k, cb) => cb(),
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
}

exported.apply(ctx)

const seatCache = new Map()
function seat(ns) {
  const rev = service.getSnapshot().revision
  const c = seatCache.get(ns)
  if (c && c.revision === rev) return c.t
  const b = service.bind(ns)
  const t = (k, p) => b(k, p)
  seatCache.set(ns, { revision: rev, t })
  return t
}
function collect(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') return out.push(String(node)), out
  if (node.props && typeof node.type === 'function' && node.type.name === 'Slider') return collect(node.type(node.props), out)
  if (node.children) for (const c of node.children) collect(c, out)
  return out
}
const render = () => collect(registration.component({ t: seat(registration.options.locale) }))

check('namespace registered at apply time', dicts.has('dsh-settings-resize'), [...dicts.keys()].join(','))
check('first paint is Chinese', render()[0] === '设置窗口尺寸', render()[0])
check('nav label is Chinese', registration.options.label() === '设置窗口尺寸', registration.options.label())

service.setLocale('en')
check('switches to English', render()[0] === 'Settings window size', render()[0])
service.setLocale('zh')
check('switches back to Chinese', render()[0] === '设置窗口尺寸', render()[0])
check(
  'the slot declares the locale namespace',
  registration.options.locale === 'dsh-settings-resize',
  registration.options.locale,
)

console.log(failed.length === 0 ? '\nALL COLD-START CHECKS PASSED' : `\n${failed.length} CHECK(S) FAILED`)
if (failed.length) process.exitCode = 1
