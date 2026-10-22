// Regression test for the reported bug: the row switched zh -> en but never back.
//
// Runs the REAL LocaleRuntime extracted from the shipped bundle, because the failure was
// the service's own single-occupant rule: register() throws when the namespace already
// holds that language, and an uncaught throw left the row with only its `en` fallback.
//
// Three scenarios:
//   A. plain switching on a fresh apply
//   B. HMR reload — the new generation applies, then the old fiber is retired
//   C. a stale claim with no live disposer (module scope was reset), the field failure
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8')
const asar = fs.readFileSync('C:/Cinstall/ProgramTools/DSH/resources/app.asar', 'utf8')

// --- extract the real LocaleRuntime from the shipped bundle ------------------------
const start = asar.indexOf('var LocaleRuntime = class {')
if (start < 0) throw new Error('LocaleRuntime not found')
let depth = 0
let i = asar.indexOf('{', start)
for (; i < asar.length; i++) {
  if (asar[i] === '{') depth++
  else if (asar[i] === '}') {
    depth--
    if (depth === 0) break
  }
}
const classText = asar.slice(start, i + 1)

const sandbox = { console }
vm.createContext(sandbox)
vm.runInContext(
  `
const LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const localeKey = (id) => String(id).toLowerCase()
const BUILT_IN_LOCALES = [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }]
function detectBrowserLocale(locales, languages) {
  if (languages === void 0) return void 0
  for (const tag of languages) {
    const requested = localeKey(tag)
    const exact = locales.find((l) => localeKey(l.id) === requested)
    if (exact !== undefined) return exact.id
    const primary = requested.split('-')[0]
    const match = locales.find((l) => localeKey(l.id).split('-')[0] === primary)
    if (match !== undefined) return match.id
  }
}
function resolveInitialLocale(locales, languages) {
  return detectBrowserLocale(locales, languages) ?? 'en'
}
${classText}
globalThis.LocaleRuntime = LocaleRuntime
`,
  sandbox,
)

// --- load the plugin ---------------------------------------------------------------
const mods = []
const styleEls = []
const pSandbox = {
  console,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: {
    documentElement: { style: { setProperty() {}, removeProperty() {} } },
    head: { append: (el) => styleEls.push(el) },
    createElement: () => ({ id: '', textContent: '', remove() {} }),
  },
  __ModuleLoader__: { load: (m) => mods.push(m) },
}
pSandbox.window = pSandbox
vm.createContext(pSandbox)
vm.runInContext(source, pSandbox)

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}

// One shared service, as the page has.
const LocaleRuntime = sandbox.LocaleRuntime
const locale = new LocaleRuntime({ effect: () => {}, emit() {}, get: () => undefined }, undefined, undefined)
locale.register('common', { zh: { ok: '确定' }, en: { ok: 'OK' } })
locale.setLocale('zh')

let registration
function makeFiber(tag) {
  const disposers = []
  const ctx = {
    effect(fn) {
      const d = fn()
      disposers.push(d)
      return d
    },
    get: (n) => (n === 'locale' ? locale : undefined),
    slots: {
      inject: (k, cb) => cb(),
      register(options, component) {
        registration = { options, component }
        return () => {}
      },
    },
  }
  return {
    tag,
    ctx,
    retire() {
      disposers.splice(0).reverse().forEach((d) => {
        if (typeof d === 'function') d()
      })
    },
  }
}

// The framework's localeSeat: a fresh `t` wrapper per revision.
const seatCache = new Map()
function seat(ns) {
  const rev = locale.getSnapshot().revision
  const cached = seatCache.get(ns)
  if (cached && cached.revision === rev) return cached.t
  const bound = locale.bind(ns)
  const t = (k, p) => bound(k, p)
  seatCache.set(ns, { revision: rev, t })
  return t
}

function collect(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (node.props && typeof node.type === 'function' && node.type.name === 'Slider') {
    return collect(node.type(node.props), out)
  }
  if (node.children) for (const c of node.children) collect(c, out)
  return out
}

const render = () => collect(registration.component({ t: seat('dsh-settings-resize') }))

const results = []
const check = (label, ok, detail) => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

// ---- A: fresh apply, plain switching ----------------------------------------------
const gen1 = makeFiber('gen1')
mods[0].factory(() => React).apply(gen1.ctx)
check('A: initial zh', render().includes('设置窗口尺寸'), render()[0])
locale.setLocale('en')
check('A: zh -> en', render().includes('Settings window size'))
locale.setLocale('zh')
check('A: en -> zh', render().includes('设置窗口尺寸'), render()[0])

// ---- B: HMR reload; new generation first, then the old fiber retires --------------
const gen2 = makeFiber('gen2')
mods[0].factory(() => React).apply(gen2.ctx)
gen1.retire()
check('B: zh survives the reload', render().includes('设置窗口尺寸'), render()[0])
locale.setLocale('en')
check('B: en after reload', render().includes('Settings window size'), render()[0])
locale.setLocale('zh')
check('B: en -> zh after reload', render().includes('设置窗口尺寸'), render()[0])
check('B: no English left behind', !render().includes('Settings window size'), render()[0])

// ---- C: stale claim with no live disposer (the field failure) ---------------------
// Drop the parked disposer the way an HMR module reset would, leaving the namespace held.
delete globalThis.__dshSettingsResizeLocale
const gen3 = makeFiber('gen3')
let thrown
try {
  mods[0].factory(() => React).apply(gen3.ctx)
} catch (error) {
  thrown = error.message
}
check('C: apply does not throw on a stale claim', thrown === undefined, thrown)
check('C: zh resolves after a stale claim', render().includes('设置窗口尺寸'), render()[0])
locale.setLocale('en')
check('C: switches to en', render().includes('Settings window size'))
locale.setLocale('zh')
check('C: switches back to zh', render().includes('设置窗口尺寸'), render()[0])

const failed = results.filter((ok) => !ok).length
console.log(failed === 0 ? '\nALL SWITCHING CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
if (failed) process.exitCode = 1
