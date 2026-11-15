// Model enable/disable: catalog edit, record keeping, and restore-on-unload.
//
// The behaviour that matters is that a disabled model disappears from `models` (so both
// model pickers stop listing it), that re-enabling puts the exact original entry back at
// its original position, and that disabling the plugin restores everything.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8')

const BT = String.fromCharCode(96)
const mods = []
const styleEls = []
const sandbox = {
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
sandbox.window = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
}

// --- a settings store shaped like the real configForms faces -----------------------
const DEEPSEEK_MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576 },
]

const state = {
  'llm-deepseek': { models: JSON.parse(JSON.stringify(DEEPSEEK_MODELS)) },
  'llm-pi-ai': {
    providers: {
      capi: {
        displayName: 'dshcapi',
        models: [{ id: 'codearts/deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
      },
    },
  },
  'dsh-settings-resize': { disabledModels: [] },
}

const writes = []
function formFor(ns) {
  return {
    getSnapshot: () => ({ value: JSON.parse(JSON.stringify(state[ns] ?? {})) }),
    subscribe: () => () => {},
    set: async (key, value) => {
      writes.push({ ns, op: 'set', key })
      state[ns] = { ...state[ns], [key]: value }
    },
    mutate: async (ops) => {
      writes.push({ ns, op: 'mutate', path: ops[0].path })
      for (const op of ops) {
        const path = op.path
        let target = state[ns]
        for (const segment of path.slice(0, -1)) target = target[segment]
        target[path[path.length - 1]] = op.value
      }
    },
  }
}

const configForms = {
  get: (ns) => (ns in state ? formFor(ns) : undefined),
}

const locale = {
  register: () => () => {},
  bind: () => (key) => key,
}

const registrations = []
const ctx = {
  effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
  get: () => undefined,
  configForms,
  slots: {
    inject: (key, cb) => cb(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  locale,
}

mods[0].factory(() => React).apply(ctx)

const results = []
const check = (label, ok, detail) => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

(async () => {
  // --- registration -----------------------------------------------------------------
  const modelReg = registrations.find((r) => r.options.name === 'settings.models.footer')
  check('registers a footer on the Models page', modelReg !== undefined)
  check('footer carries a locale', modelReg?.options.locale === 'dsh-settings-resize')
  check('footer renders a component', typeof modelReg?.component === 'function')
  check(
    'footer injects configForms',
    typeof modelReg?.options.inject === 'function' &&
      modelReg.options.inject().configForms === configForms,
  )

  // --- disable / enable through the real component callbacks -------------------------
  // Drive the panel the way the UI does: grab its injected props, then call the same paths.
  const t = (key, params) => {
    const dict = {
      modelSection: '模型开关',
      modelSectionHint: 'hint',
      modelDisable: '关闭',
      modelEnable: '启用',
      modelDisabledBadge: '已关闭',
      modelRestoreAll: '全部恢复',
      modelRestored: '已恢复 {count} 个模型',
      modelWriteFailed: '写入失败：{message}',
    }
    let text = dict[key] ?? key
    if (params) text = text.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
    return text
  }

  // The panel's toggle closure is internal; exercise the exported behaviour through a
  // render + simulated click instead of reaching into module scope.
  function collect(node, out = []) {
    if (node === null || node === undefined || node === false) return out
    if (typeof node === 'string' || typeof node === 'number') return out.push(String(node)), out
    if (node.children) for (const child of node.children) collect(child, out)
    return out
  }

  const panel = modelReg.component({ t, configForms })
  const text = collect(panel)
  check('panel lists the DeepSeek provider', text.includes('DeepSeek'))
  check('panel lists a pi-ai provider', text.includes('dshcapi'))
  check('panel lists every model', text.includes('DeepSeek-V4.1-Flash') && text.includes('DeepSeek-V4-Pro'))

  // Find the switch for deepseek-v4-pro and click it.
  function findSwitch(node, modelName) {
    if (node === null || typeof node !== 'object') return undefined
    const props = node.props ?? {}
    if (
      props.role === 'switch' &&
      typeof props['aria-label'] === 'string' &&
      props['aria-label'].includes(modelName)
    ) {
      return props
    }
    for (const child of node.children ?? []) {
      const hit = findSwitch(child, modelName)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  const proSwitch = findSwitch(panel, 'DeepSeek-V4-Pro')
  check('every model row has a switch', proSwitch !== undefined)
  check('an enabled model reports aria-checked=true', proSwitch?.['aria-checked'] === true)

  // --- disable ----------------------------------------------------------------------
  await proSwitch.onClick()

  const deepseekAfter = state['llm-deepseek'].models
  check(
    'disabling removes the model from the catalog',
    deepseekAfter.length === 1 && deepseekAfter[0].id === 'deepseek-flash',
    JSON.stringify(deepseekAfter.map((m) => m.id)),
  )
  check(
    'the removal is a path-addressed catalog write',
    writes.some((w) => w.ns === 'llm-deepseek' && w.op === 'mutate' && w.path.join('.') === 'models'),
  )

  const records = state['dsh-settings-resize'].disabledModels
  check('a removal record is stored', records.length === 1)
  check('the record keeps the provider', records[0]?.provider === 'llm-deepseek')
  check('the record keeps the exact entry', records[0]?.entry?.id === 'deepseek-v4-pro')
  check(
    'the record keeps the original index',
    records[0]?.index === 1,
    String(records[0]?.index),
  )
  check(
    'the record preserves fields beyond id and name',
    records[0]?.entry?.contextWindow === 1048576,
  )

  // --- re-render shows the disabled state --------------------------------------------
  const panel2 = modelReg.component({ t, configForms })
  const proSwitch2 = findSwitch(panel2, 'DeepSeek-V4-Pro')
  check('a disabled model reports aria-checked=false', proSwitch2?.['aria-checked'] === false)
  check('the disabled badge renders', collect(panel2).includes('已关闭'))

  // --- enable again -----------------------------------------------------------------
  await proSwitch2.onClick()
  const restored = state['llm-deepseek'].models
  check('re-enabling restores the model', restored.some((m) => m.id === 'deepseek-v4-pro'))
  check('the original position is preserved', restored[1]?.id === 'deepseek-v4-pro', restored[1]?.id)
  check(
    'the original fields survive the round trip',
    restored[1]?.contextWindow === 1048576 && restored[1]?.name === 'DeepSeek-V4-Pro',
    JSON.stringify(restored[1]),
  )
  check('the record is cleared', state['dsh-settings-resize'].disabledModels.length === 0)

  // --- disabling the whole provider --------------------------------------------------
  // Turn off both DeepSeek models: the catalog empties, and the picker has no group left.
  for (const id of ['deepseek-flash', 'deepseek-v4-pro']) {
    const live = modelReg.component({ t, configForms })
    const sw = findSwitch(live, id === 'deepseek-flash' ? 'DeepSeek-V4.1-Flash' : 'DeepSeek-V4-Pro')
    await sw.onClick()
  }
  check(
    'disabling every model empties the provider catalog',
    state['llm-deepseek'].models.length === 0,
    String(state['llm-deepseek'].models.length),
  )

  // --- restore-all (also the unload path) --------------------------------------------
  const panel3 = modelReg.component({ t, configForms })
  const restore = (function findRestore(node) {
    if (node === null || typeof node !== 'object') return undefined
    const props = node.props ?? {}
    if (props.className === 'dsh-settings-resize-models-restore') return props
    for (const child of node.children ?? []) {
      const hit = findRestore(child)
      if (hit !== undefined) return hit
    }
    return undefined
  })(panel3)
  check('a restore-all control appears when something is disabled', restore !== undefined)
  await restore.onClick()
  check(
    'restore-all brings every model back',
    state['llm-deepseek'].models.length === 2,
    String(state['llm-deepseek'].models.length),
  )
  check('records are cleared after restore-all', state['dsh-settings-resize'].disabledModels.length === 0)

  // --- unload restores ---------------------------------------------------------------
  const livePanel = modelReg.component({ t, configForms })
  const flashSwitch = findSwitch(livePanel, 'DeepSeek-V4.1-Flash')
  await flashSwitch.onClick()
  check('a model is disabled before unload', state['llm-deepseek'].models.length === 1)

  // Re-apply so we can capture the unload cleanup and invoke it.
  const cleanups = []
  const ctx2 = {
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    get: () => undefined,
    configForms,
    slots: { inject: (key, cb) => cb(), register: () => () => {} },
    locale,
  }
  mods[0].factory(() => React).apply(ctx2)
  for (const dispose of [...cleanups].reverse()) dispose()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check(
    'disabling the plugin restores the catalog',
    state['llm-deepseek'].models.length === 2,
    String(state['llm-deepseek'].models.length),
  )

  const failed = results.filter((ok) => !ok).length
  console.log(failed === 0 ? '\nALL MODEL SWITCH CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
  if (failed) process.exitCode = 1
})().catch((error) => { console.error(error); process.exitCode = 1 })
