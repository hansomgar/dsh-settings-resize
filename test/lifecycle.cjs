// Lifecycle simulation for dsh-settings-resize's client half.
// Runs the real client.js against a minimal DOM/Cordis shim: registers the factory,
// applies the plugin, exercises storage normalization, then disposes every effect
// and checks for residue. Not a substitute for the live page; it pins the pure logic.
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')

const store = new Map()
const props = new Map()
const styleEls = []
const mods = []

const sandbox = {
  console,
  innerHeight: 900,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  document: {
    documentElement: {
      style: {
        setProperty: (k, v) => props.set(k, v),
        removeProperty: (k) => props.delete(k),
      },
    },
    head: { append: (el) => styleEls.push(el) },
    createElement: () => {
      const el = {
        id: '',
        textContent: '',
        remove() {
          const i = styleEls.indexOf(el)
          if (i >= 0) styleEls.splice(i, 1)
        },
      }
      return el
    },
  },
  __ModuleLoader__: { load: (m) => mods.push(m) },
}
sandbox.window = sandbox
sandbox.self = sandbox

const requireStub = (id) => {
  if (id === 'react') {
    return {
      createElement: (type, p, ...children) => ({ type, props: p || {}, children }),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useCallback: (fn) => fn,
      useRef: (value) => ({ current: value }),
    }
  }
  throw new Error('unexpected require: ' + id)
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const assert = (label, ok) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) process.exitCode = 1
}

assert('exactly one module registered', mods.length === 1)
assert('module id is dsh-settings-resize', mods.length === 1 && mods[0].id === 'dsh-settings-resize')

const exported = mods[0].factory(requireStub)
assert('exports.name', exported.name === 'dsh-settings-resize')
assert(
  'exports.inject declares slots and locale',
  JSON.stringify(exported.inject) === '["slots","locale"]',
  JSON.stringify(exported.inject),
)
assert('exports.apply is a function', typeof exported.apply === 'function')

const effects = []
const injected = []
const registered = []
let registration

// Mirrors the real locale service closely enough to prove the plugin's contract: one
// `register(ns, {zh, en})` call, a bound translate function, and `{name}` interpolation.
let activeLocale = 'zh'
const dictionaries = new Map()
const localeStub = {
  register(ns, dicts) {
    // Re-registration is how a real reload behaves: the previous registration is disposed
    // with the plugin's fiber before apply() runs again.
    dictionaries.set(ns, dicts)
    if (!registered.includes(ns)) registered.push(ns)
    return () => dictionaries.delete(ns)
  },
  bind(ns) {
    return (key, params) => {
      const dict = dictionaries.get(ns)
      if (dict === undefined) return key
      const template = dict[activeLocale]?.[key] ?? dict.en?.[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      )
    }
  },
}

const ctx = {
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
  get(name) {
    return undefined
  },
  get locale() {
    return localeStub
  },
  slots: {
    // The real service returns a disposer to the caller's ctx.effect; it is not an
    // effect of its own, so the stub records only the returned disposer.
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, component) {
      registration = { options, component }
      return () => {
        registration = undefined
      }
    },
  },
}

const start = () => {
  props.clear()
  styleEls.length = 0
  effects.length = 0
  injected.length = 0
  registered.length = 0
  exported.apply(ctx)
}

// 1. Fresh start: shipped defaults.
store.clear()
start()
assert('four effects registered (style, locale, variables, slot)', effects.length === 4)
assert('waits on the General settings slot declaration', injected.join(',') === 'settings.general.item')
assert('registers exactly one locale namespace', registered.join(',') === 'dsh-settings-resize')
assert(
  'both zh and en dictionaries are registered in one call',
  (() => {
    const dicts = dictionaries.get('dsh-settings-resize')
    return dicts !== undefined && dicts.zh !== undefined && dicts.en !== undefined
  })(),
)
assert(
  'zh and en carry the same keys, so neither can be half-translated',
  (() => {
    const dicts = dictionaries.get('dsh-settings-resize')
    const zk = Object.keys(dicts.zh).sort()
    const ek = Object.keys(dicts.en).sort()
    return zk.length === ek.length && zk.every((k, i) => k === ek[i])
  })(),
)
assert(
  'every UI string comes from the dictionaries, not inline markup',
  (() => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
    // Strip comments and the zh dictionary itself, then look for Chinese in any string
    // literal that could reach the DOM.
    const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
    const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '')
    const dictStart = withoutLineComments.indexOf('const zh = {')
    const dictEnd = withoutLineComments.indexOf('const en = {')
    const outsideDict =
      withoutLineComments.slice(0, dictStart) + withoutLineComments.slice(dictEnd)
    const chineseLiterals = outsideDict.match(/'[^'\n]*[\u4e00-\u9fff][^'\n]*'/g) || []
    return chineseLiterals.length === 0
  })(),
)
assert('registration declares the locale namespace', registration.options.locale === 'dsh-settings-resize')
assert(
  'the row label follows the active language',
  (() => {
    const zhLabel = registration.options.label()
    activeLocale = 'en'
    const enLabel = registration.options.label()
    activeLocale = 'zh'
    return zhLabel === '设置窗口尺寸' && enLabel === 'Settings window size'
  })(),
)
assert(
  'style element created with stable id',
  styleEls.length === 1 && styleEls[0].id === 'dsh-settings-resize-style',
)
assert(
  'style sets the panel size with !important',
  /\[data-shortcut-modal="settings"\]/.test(styleEls[0].textContent) &&
    /width:\s*var\(--dsh-settings-w\)\s*!important/.test(styleEls[0].textContent) &&
    /height:\s*var\(--dsh-settings-h\)\s*!important/.test(styleEls[0].textContent) &&
    /max-width:\s*calc\(100vw - 48px\)\s*!important/.test(styleEls[0].textContent) &&
    /max-height:\s*calc\(100vh - 2 \* max\(24px, var\(--dsh-frame-overlay-top, 24px\)\)\)\s*!important/.test(
      styleEls[0].textContent,
    ),
)
assert('no hashed class selector is used', !/wCInkW_panel|[a-zA-Z]{6}_panel\{/.test(styleEls[0].textContent))
assert('default 800px width applied', props.get('--dsh-settings-w') === '800px')
assert('default 800px height applied', props.get('--dsh-settings-h') === '800px')
assert('default is fully opaque', props.get('--dsh-settings-alpha') === '100%')
assert('default draws no outline', props.get('--dsh-settings-edge') === '0%')
assert(
  'panel surface is mixed through the alpha variable',
  /background:\s*color-mix\(\s*in srgb,\s*var\(--dsw-alias-bg-layer-2\)\s*var\(--dsh-settings-alpha,\s*100%\),\s*transparent\s*\)\s*!important/.test(
    styleEls[0].textContent,
  ),
)
assert(
  'panel edge is mixed through the edge variable',
  /outline:\s*\.5px solid\s*color-mix\(in srgb,\s*var\(--dsw-alias-border-l2\)\s*var\(--dsh-settings-edge,\s*0%\),\s*transparent\)\s*!important/.test(
    styleEls[0].textContent,
  ),
)
assert(
  'text and controls are not faded',
  !/opacity:\s*var\(/.test(styleEls[0].textContent) &&
    !/color:\s*color-mix/.test(styleEls[0].textContent),
)
assert('registration options', registration.options.id === 'settings-resize' && registration.options.order === 18)
assert('registration targets the General settings slot', registration.options.name === 'settings.general.item')
assert('registration renders a component', typeof registration.component === 'function')
assert(
  'stored record is the documented shape',
  store.get('dsh.settingsResize.v1') ===
    '{"width":800,"height":800,"heightUnit":"px","transparency":0}',
)

// 2. A stored 1200 x 90vh record (the shape the spec names) resolves to pixels.
store.set('dsh.settingsResize.v1', JSON.stringify({ width: 1200, height: 90, heightUnit: 'vh' }))
start()
assert('stored width restored', props.get('--dsh-settings-w') === '1200px')
assert('90vh of a 900px viewport becomes 810px', props.get('--dsh-settings-h') === '810px')
assert('a record without transparency stays opaque', props.get('--dsh-settings-alpha') === '100%')

// 2b. Transparency: the slider measures transparency, the property carries surface opacity.
store.set(
  'dsh.settingsResize.v1',
  JSON.stringify({ width: 1000, height: 900, heightUnit: 'px', transparency: 30 }),
)
start()
assert('30% transparency becomes 70% surface opacity', props.get('--dsh-settings-alpha') === '70%')

store.set(
  'dsh.settingsResize.v1',
  JSON.stringify({ width: 1000, height: 900, heightUnit: 'px', transparency: 0 }),
)
start()
assert('0% transparency is fully opaque', props.get('--dsh-settings-alpha') === '100%')

// 3. Out-of-range and corrupt records are clamped / ignored, never written raw.
store.set('dsh.settingsResize.v1', JSON.stringify({ width: 99999, height: 1 }))
start()
assert('width clamps to 2400', props.get('--dsh-settings-w') === '2400px')
assert('height clamps to 480', props.get('--dsh-settings-h') === '480px')

store.set('dsh.settingsResize.v1', JSON.stringify({ width: 900, height: 900, transparency: 500 }))
start()
assert('transparency clamps to 100 (fully transparent, edge kept)', props.get('--dsh-settings-alpha') === '0%')
assert('edge outline reaches full strength at 100%', props.get('--dsh-settings-edge') === '100%')

store.set('dsh.settingsResize.v1', JSON.stringify({ width: 900, height: 900, transparency: 100 }))
start()
assert('stored 100% transparency is honoured', props.get('--dsh-settings-alpha') === '0%')

store.set('dsh.settingsResize.v1', JSON.stringify({ width: 900, height: 900, transparency: 0 }))
start()
assert('0% transparency draws no outline', props.get('--dsh-settings-edge') === '0%')

store.set('dsh.settingsResize.v1', JSON.stringify({ width: 900, height: 900, transparency: -40 }))
start()
assert('negative transparency clamps to 0', props.get('--dsh-settings-alpha') === '100%')

store.set('dsh.settingsResize.v1', 'not json')
start()
assert('corrupt record falls back to 800', props.get('--dsh-settings-w') === '800px' && props.get('--dsh-settings-h') === '800px')
assert('corrupt record falls back to opaque', props.get('--dsh-settings-alpha') === '100%')

// 4. Dispose every effect: no style tag, no custom properties, no registration.
start()
store.set(
  'dsh.settingsResize.v1',
  JSON.stringify({ width: 1600, height: 1200, heightUnit: 'px', transparency: 40 }),
)
start()
assert('custom size live before dispose', props.get('--dsh-settings-w') === '1600px')
assert('custom transparency live before dispose', props.get('--dsh-settings-alpha') === '60%')
assert('custom edge live before dispose', props.get('--dsh-settings-edge') === '40%')
for (const entry of effects.slice().reverse()) if (typeof entry.dispose === 'function') entry.dispose()
assert('style element removed on dispose', styleEls.length === 0)
assert('custom properties removed on dispose', props.size === 0)
assert('slot registration removed on dispose', registration === undefined)
assert('localStorage kept (so re-enabling restores the choice)', store.get('dsh.settingsResize.v1') !== null)

console.log('\ndisposal labels: ' + effects.map((e) => e.label).join(' | '))
