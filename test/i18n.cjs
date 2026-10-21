// Renders the Settings row under both locales and checks every visible string switches.
// This is the closest thing to a visual check available without browser control: it runs
// the real component against the real dictionaries and a faithful `t`.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8')

const mods = []
const styleEls = []
const propsMap = new Map()
let activeLocale = 'zh'
const dictionaries = new Map()

const sandbox = {
  console,
  innerHeight: 900,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  document: {
    documentElement: {
      style: {
        setProperty: (k, v) => propsMap.set(k, v),
        removeProperty: (k) => propsMap.delete(k),
      },
    },
    head: { append: (el) => styleEls.push(el) },
    createElement: () => ({
      id: '',
      textContent: '',
      remove() {
        const i = styleEls.indexOf(this)
        if (i >= 0) styleEls.splice(i, 1)
      },
    }),
  },
  __ModuleLoader__: { load: (m) => mods.push(m) },
}
sandbox.window = sandbox

let pending = []
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  useState(init) {
    const i = pending.length
    pending.push(typeof init === 'function' ? init() : init)
    return [pending[i], () => {}]
  },
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}
const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const exported = mods[0].factory(requireStub)

const localeStub = {
  register(ns, dicts) {
    dictionaries.set(ns, dicts)
    return () => dictionaries.delete(ns)
  },
  bind(ns) {
    return (key, params) => {
      const dict = dictionaries.get(ns)
      const template = dict?.[activeLocale]?.[key] ?? dict?.en?.[key] ?? key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
    }
  },
}

let registration
const ctx = {
  effect(fn) {
    return fn()
  },
  get: (name) => (name === 'locale' ? localeStub : undefined),
  slots: {
    inject: (key, cb) => cb(),
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
}

exported.apply(ctx)

// Collect every string the tree can put on screen.
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node === 'function') {
    return textOf(node({ t: registration.options.locale ? localeStub.bind('dsh-settings-resize') : undefined, useStore: undefined }), out)
  }
  if (node.children) for (const child of node.children) textOf(child, out)
  if (node.props) {
    // Slider sub-components arrive as element nodes with a function type.
    if (typeof node.type === 'function' && node.type.name === 'Slider') {
      pending = []
      const rendered = node.type(node.props)
      textOf(rendered, out)
    }
    if (typeof node.props['aria-label'] === 'string') out.push(node.props['aria-label'])
  }
  return out
}

function render() {
  pending = []
  const t = localeStub.bind('dsh-settings-resize')
  // Section reads its dictionaries through the framework-injected seat.
  const tree = registration.component({ t })
  return textOf(tree)
}

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '\n      ' + detail))
  if (!ok) failures.push(label)
}

activeLocale = 'zh'
const zhText = render()
console.log('--- zh render ---')
console.log(zhText.join(' | '))

activeLocale = 'en'
const enText = render()
console.log('\n--- en render ---')
console.log(enText.join(' | '))

console.log('')

const CJK = /[\u4e00-\u9fff]/
check('zh render contains Chinese', zhText.some((s) => CJK.test(s)))
check('en render contains no Chinese at all', !enText.some((s) => CJK.test(s)), enText.filter((s) => CJK.test(s)).join(' / '))
check('zh title', zhText.includes('设置窗口尺寸'))
check('en title', enText.includes('Settings window size'))
check('zh slider names', zhText.includes('宽度') && zhText.includes('高度') && zhText.includes('透明度'))
check('en slider names', enText.includes('Width') && enText.includes('Height') && enText.includes('Transparency'))
check('zh reset button', zhText.includes('恢复默认'))
check('en reset button', enText.includes('Reset to default'))
check('zh current line', zhText.some((s) => s.startsWith('当前：')), zhText.find((s) => s.startsWith('当前')))
check('en current line', enText.some((s) => s.startsWith('Current:')), enText.find((s) => s.startsWith('Current')))
check('zh interpolation filled', zhText.some((s) => s.includes('800px × 800px')) && !zhText.some((s) => s.includes('{width}')))
check('en interpolation filled', enText.some((s) => s.includes('800px × 800px')) && !enText.some((s) => s.includes('{width}')))
check('no raw key leaked in either language', ![...zhText, ...enText].some((s) => /^(title|description|width|height|transparency|reset|footnote|current)$/.test(s)))
check('the row label switches', registration.options.label() === 'Settings window size', registration.options.label())
activeLocale = 'zh'
check('the row label switches back', registration.options.label() === '设置窗口尺寸', registration.options.label())

console.log(failures.length === 0 ? '\nALL I18N CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
if (failures.length) process.exitCode = 1
