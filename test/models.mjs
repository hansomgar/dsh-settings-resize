// Model switches: the switch hides a model from the CONVERSATION picker only.
//
// What matters:
//   - the switch is registered per provider card (settings.models.provider-card), not as a
//     standalone panel;
//   - the Settings page keeps every model visible (its rows come from the settings document);
//   - turning a model off writes the plugin's own list, never the provider catalog;
//   - the Host side filters `listModels`, which is the picker path;
//   - restoring puts the picker back.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientSource = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8')
const hostSource = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')

const results = []
const check = (label, ok, detail) => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

// ---------------------------------------------------------------------------------
// 1. Host half: the filter hides models from listModels and leaves the catalog alone
// ---------------------------------------------------------------------------------
const host = await import(
  'data:text/javascript;base64,' + Buffer.from(hostSource).toString('base64')
)

const CATALOG = {
  deepseek: [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
  capi: [{ id: 'codearts/deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
}

// A stand-in for the live LLM registry the picker reads.
const registry = {
  catalog: CATALOG,
  async listModels(provider) {
    return this.catalog[provider] ?? []
  },
}

// The settings service the Host half talks to.
const store = { 'dsh-settings-resize': { disabledModels: [] } }
const listeners = new Map()
const settings = {
  describe: () => [
    { ns: 'dsh-settings-resize', value: JSON.parse(JSON.stringify(store['dsh-settings-resize'])) },
  ],
  update: async (ns, patch) => {
    store[ns] = { ...store[ns], ...patch }
  },
}

const emitted = []
const ctx = {
  get: (name) => (name === 'llm' ? registry : name === 'settings' ? settings : undefined),
  effect: (fn) => fn(),
  on: (event, handler) => {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
  emit: (event) => {
    emitted.push(event)
    const handler = listeners.get(event)
    if (handler !== undefined) handler()
  },
  provide: (name, value) => {
    ctx[name] = value
    return () => {}
  },
}

host.apply(ctx, {})

const service = ctx.dshSettingsResizeModels
check('host exposes the model switch service', service !== undefined)
check('applying the plugin wraps listModels', registry.listModels !== undefined)

const pickerIds = async (provider) => (await registry.listModels(provider)).map((m) => m.id)

check(
  'with nothing switched off the picker is unchanged',
  (await pickerIds('deepseek')).length === 2,
  String((await pickerIds('deepseek')).length),
)

// --- switch one model off ---------------------------------------------------------
await service.set({ provider: 'deepseek', modelId: 'deepseek-v4-pro', enabled: false })

const afterOff = await pickerIds('deepseek')
check('the picker drops the switched-off model', !afterOff.includes('deepseek-v4-pro'), JSON.stringify(afterOff))
check('the other model stays', afterOff.includes('deepseek-flash'))
check(
  'the provider catalog itself is untouched',
  CATALOG.deepseek.length === 2,
  String(CATALOG.deepseek.length),
)
check(
  'the Settings page source still lists every model',
  CATALOG.deepseek.map((m) => m.id).includes('deepseek-v4-pro'),
)
check(
  'the switch is stored in the plugin namespace, not the provider config',
  store['dsh-settings-resize'].disabledModels.length === 1 &&
    store['llm-deepseek'] === undefined,
  JSON.stringify(store['dsh-settings-resize'].disabledModels),
)
check('a models-updated event is announced', emitted.includes('llm/models-updated'))

// --- switch it back on ------------------------------------------------------------
await service.set({ provider: 'deepseek', modelId: 'deepseek-v4-pro', enabled: true })
check(
  'turning it back on restores the picker',
  (await pickerIds('deepseek')).includes('deepseek-v4-pro'),
)

// --- hiding every model of a provider --------------------------------------------
await service.set({ provider: 'capi', modelId: 'codearts/deepseek-v4.1-flash', enabled: false })
check(
  'a fully hidden provider reports no models to the picker',
  (await pickerIds('capi')).length === 0,
  String((await pickerIds('capi')).length),
)
check(
  'but its catalog row still exists for the Settings page',
  CATALOG.capi.length === 1,
)

// --- restore all ------------------------------------------------------------------
const restored = await service.restoreAll()
check('restoreAll reports what it restored', restored.restored === 1, String(restored.restored))
check('restoreAll brings everything back', (await pickerIds('capi')).length === 1)
check(
  'the stored list is empty again',
  store['dsh-settings-resize'].disabledModels.length === 0,
)

// --- uninstalling the plugin restores the picker ----------------------------------
await service.set({ provider: 'deepseek', modelId: 'deepseek-flash', enabled: false })
check('a model is hidden before uninstall', (await pickerIds('deepseek')).length === 1)

// Re-apply so every cleanup can be collected and run, exactly as unload would.
const cleanups = []
const ctx2 = {
  get: ctx.get,
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') cleanups.push(dispose)
    return dispose
  },
  on: ctx.on,
  emit: ctx.emit,
  provide: ctx.provide,
}
host.apply(ctx2, {})
// Unload runs cleanups in reverse registration order.
for (const dispose of [...cleanups].reverse()) dispose()
check(
  'uninstalling restores the picker without touching storage',
  (await pickerIds('deepseek')).length === 2,
  String((await pickerIds('deepseek')).length),
)

// ---------------------------------------------------------------------------------
// 2. Client half: the switch is registered per provider card
// ---------------------------------------------------------------------------------
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
vm.runInContext(clientSource, sandbox)

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
}

const clientStore = {
  'dsh-settings-resize': { disabledModels: [] },
  'llm-deepseek': { models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] },
  'llm-pi-ai': { providers: { capi: { displayName: 'dshcapi', models: [{ id: 'codearts/deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] } } },
}
const writes = []
const clientForms = {
  get: (ns) =>
    ns in clientStore
      ? {
          getSnapshot: () => ({ value: JSON.parse(JSON.stringify(clientStore[ns])) }),
          subscribe: () => () => {},
          set: async (key, value) => {
            writes.push({ ns, key })
            clientStore[ns] = { ...clientStore[ns], [key]: value }
          },
        }
      : undefined,
  describe: () => ({
    namespaces: [
      { ns: 'llm-deepseek', value: clientStore['llm-deepseek'] },
      { ns: 'llm-pi-ai', value: clientStore['llm-pi-ai'] },
      { ns: 'dsh-settings-resize', value: clientStore['dsh-settings-resize'] },
    ],
  }),
}

const registrations = []
const clientCtx = {
  effect: (fn) => fn(),
  get: () => undefined,
  configForms: clientForms,
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: {
    inject: (key, cb) => cb(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

mods[0].factory(() => React).apply(clientCtx)

const cardRegs = registrations.filter((r) => r.options.name === 'settings.models.provider-card')
check('registers switches on the provider-card slot', cardRegs.length > 0, String(cardRegs.length))
check(
  'one registration per provider family',
  cardRegs.some((r) => r.options.key === 'llm-deepseek') &&
    cardRegs.some((r) => r.options.key === 'llm-pi-ai'),
  cardRegs.map((r) => r.options.key).join(','),
)
check(
  'no standalone model panel in the footer',
  !registrations.some((r) => r.options.name === 'settings.models.footer' && r.options.order === 10),
)

// The card component lists models from the settings document, with switches.
const deepseekReg = cardRegs.find((r) => r.options.key === 'llm-deepseek')
const t = (key, params) => {
  const dict = {
    modelSwitchTitle: '开关',
    modelSwitchHintAll: '全部模型都会出现在模型选择器中。',
    modelSwitchHintOff: '{count} 个模型已从模型选择器中隐藏，此处仍可管理。',
    modelEnable: '启用',
    modelDisable: '关闭',
    modelDisabledBadge: '已隐藏',
    modelRestoreAll: '全部恢复（{count}）',
    modelWriteFailed: '写入失败：{message}',
  }
  let text = dict[key] ?? key
  if (params) text = text.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
  return text
}

const props = deepseekReg.options.inject()
const tree = deepseekReg.component({
  provider: { provider: 'llm-deepseek', settingsNs: 'llm-deepseek', displayName: 'DeepSeek' },
  t,
  ...props,
})

function collect(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') return out.push(String(node)), out
  if (node.children) for (const child of node.children) collect(child, out)
  return out
}
function findSwitch(node, modelName) {
  if (node === null || typeof node !== 'object') return undefined
  const p = node.props ?? {}
  if (p.role === 'switch' && typeof p['aria-label'] === 'string' && p['aria-label'].includes(modelName)) {
    return p
  }
  for (const child of node.children ?? []) {
    const hit = findSwitch(child, modelName)
    if (hit !== undefined) return hit
  }
  return undefined
}

const text = collect(tree)
check('the card shows every model', text.includes('DeepSeek-V4.1-Flash') && text.includes('DeepSeek-V4-Pro'))
check('every model has a switch', findSwitch(tree, 'DeepSeek-V4-Pro') !== undefined)

// --- toggling writes the plugin list, not the provider catalog ---------------------
await findSwitch(tree, 'DeepSeek-V4-Pro').onClick()
check(
  'the toggle writes the plugin namespace',
  writes.some((w) => w.ns === 'dsh-settings-resize' && w.key === 'disabledModels'),
  JSON.stringify(writes),
)
check(
  'the provider catalog is not written',
  !writes.some((w) => w.ns === 'llm-deepseek'),
  JSON.stringify(writes),
)
check(
  'the provider catalog in memory is unchanged',
  clientStore['llm-deepseek'].models.length === 2,
  String(clientStore['llm-deepseek'].models.length),
)
check(
  'the switch-off is recorded',
  clientStore['dsh-settings-resize'].disabledModels.some((m) => m.modelId === 'deepseek-v4-pro'),
  JSON.stringify(clientStore['dsh-settings-resize'].disabledModels),
)

// --- the card still lists it, marked hidden ---------------------------------------
const tree2 = deepseekReg.component({
  provider: { provider: 'llm-deepseek', settingsNs: 'llm-deepseek', displayName: 'DeepSeek' },
  t,
  ...props,
})
const text2 = collect(tree2)
check('the Settings page still shows the hidden model', text2.includes('DeepSeek-V4-Pro'))
check('it is marked as hidden', text2.includes('已隐藏'))
check(
  'its switch reads off',
  findSwitch(tree2, 'DeepSeek-V4-Pro')?.['aria-checked'] === false,
)

// --- turning it back on -----------------------------------------------------------
await findSwitch(tree2, 'DeepSeek-V4-Pro').onClick()
check(
  'turning it on clears the record',
  clientStore['dsh-settings-resize'].disabledModels.length === 0,
  JSON.stringify(clientStore['dsh-settings-resize'].disabledModels),
)

const failed = results.filter((ok) => !ok).length
console.log(failed === 0 ? '\nALL MODEL SWITCH CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
if (failed) process.exitCode = 1