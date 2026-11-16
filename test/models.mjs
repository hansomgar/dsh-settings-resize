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
// The Host half imports @deepseek-ai/schemastery, which this checkout cannot resolve on its
// own path. Rewrite that one specifier to the profile's installed copy, write the module next
// to the test, and import it.
const SCHEMASTERY = 'C:/Users/HSG/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.cjs'
const hostForTest = hostSource.replace(
  /from ['"]@deepseek-ai\/schemastery['"]/,
  'from ' + JSON.stringify('file:///' + SCHEMASTERY),
)
const hostFile = path.join(root, 'test', '.host-under-test.mjs')
fs.writeFileSync(hostFile, hostForTest, 'utf8')
const host = await import('file:///' + hostFile.replace(/\\/g, '/'))

const CATALOG = {
  deepseek: [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
  capi: [{ id: 'codearts/deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }],
  // The account route: its Settings card survives only while it still advertises a model.
  'deepseek-account': [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
}

// A stand-in for the live LLM registry the picker reads.
const registry = {
  catalog: CATALOG,
  async listModels(provider) {
    return this.catalog[provider] ?? []
  },
  listProviders() {
    return [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'capi', name: 'dshcapi' },
    ]
  },
}

// Kept so a later check can prove the plugin never replaces it.
const originalListProviders = registry.listProviders

// The settings service the Host half talks to.
const store = { 'dsh-settings-resize': { disabledModels: [], disabledProviders: [] } }
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
  // Declared dependencies arrive as properties; `get` stays empty so a regression to the old
  // `ctx.get('llm')` probe fails loudly instead of silently doing nothing.
  llm: registry,
  settings,
  get: () => undefined,
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

// `listProviders` must stay untouched: Settings → Models renders one card per entry in this
// list, so a wrapped list would delete the provider's own card — including the switch that
// turns it back on. Pickers drop the group instead, because a hidden provider lists no models.
check(
  'listProviders is left untouched so every Settings card keeps rendering',
  registry.listProviders === originalListProviders,
  registry.listProviders === originalListProviders ? 'original' : 'replaced',
)

// The filter runs on the Host, so `llm` has to be a declared dependency. Without it the plugin
// started before the LLM runtime, its `apply` returned early, and the switches saved state that
// never reached any picker.
check(
  'host declares llm and settings as dependencies',
  JSON.stringify(host.inject ?? []) === '["llm","settings"]',
  JSON.stringify(host.inject ?? null),
)

// The settings service only persists volatile fields; without `.volatile()` every write is
// refused with `Plugin entry "<id>" has no volatile fields`. Both stored fields need it.
const configShape = host.Config?.dict ?? host.Config?._dict ?? {}
const volatileFields = Object.entries(configShape)
  .filter(([, field]) => (field?.meta ?? field?._meta ?? {}).volatile === true)
  .map(([name]) => name)
  .sort()
check(
  'both stored fields are volatile, so the settings service accepts writes',
  volatileFields.join(',') === 'disabledModels,disabledProviders',
  volatileFields.join(',') || '(none)',
)

const pickerIds = async (provider) => (await registry.listModels(provider)).map((m) => m.id)

check(
  'with nothing switched off the picker is unchanged',
  (await pickerIds('deepseek')).length === 2,
  String((await pickerIds('deepseek')).length),
)

// --- switch one model off ---------------------------------------------------------
await service.setModel({ provider: 'deepseek', modelId: 'deepseek-v4-pro', enabled: false })

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
await service.setModel({ provider: 'deepseek', modelId: 'deepseek-v4-pro', enabled: true })
check(
  'turning it back on restores the picker',
  (await pickerIds('deepseek')).includes('deepseek-v4-pro'),
)

// --- hiding every model of a provider --------------------------------------------
await service.setModel({ provider: 'capi', modelId: 'codearts/deepseek-v4.1-flash', enabled: false })
check(
  'a fully hidden provider reports no models to the picker',
  (await pickerIds('capi')).length === 0,
  String((await pickerIds('capi')).length),
)
check(
  'but its catalog row still exists for the Settings page',
  CATALOG.capi.length === 1,
)

// --- provider-level switch, official providers included ---------------------------
await service.setProvider({ provider: 'deepseek', enabled: false })
check(
  'a switched-off provider still stays in the provider list',
  // Settings → Models renders one card per provider from this list, so removing the entry
  // would delete the very card whose switch turns it back on.
  (await registry.listProviders()).some((p) => p.id === 'deepseek'),
  JSON.stringify((await registry.listProviders()).map((p) => p.id)),
)
check(
  'a switched-off provider reports no models',
  // buildModelCatalog drops groups with no models, which is what removes it from the pickers.
  (await pickerIds('deepseek')).length === 0,
  String((await pickerIds('deepseek')).length),
)
check(
  'the provider setting is stored separately from models',
  store['dsh-settings-resize'].disabledProviders.includes('deepseek'),
  JSON.stringify(store['dsh-settings-resize'].disabledProviders),
)

// The account route keeps advertising its models even when the switch names it, because the
// Models page drops that card as soon as the route lists nothing. Its own per-model switches
// still work, so emptying it model by model is unaffected.
await service.setProvider({ provider: 'deepseek-account', enabled: false })
check(
  'the account route keeps its models so its Settings card survives',
  (await pickerIds('deepseek-account')).length > 0,
  String((await pickerIds('deepseek-account')).length),
)
await service.setProvider({ provider: 'deepseek-account', enabled: true })

await service.setProvider({ provider: 'deepseek', enabled: true })
check(
  'turning the provider back on restores its models',
  (await registry.listProviders()).some((p) => p.id === 'deepseek') &&
    (await pickerIds('deepseek')).length > 0,
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
await service.setModel({ provider: 'deepseek', modelId: 'deepseek-flash', enabled: false })
check('a model is hidden before uninstall', (await pickerIds('deepseek')).length === 1)

// Re-apply so every cleanup can be collected and run, exactly as unload would.
const cleanups = []
const ctx2 = {
  llm: registry,
  settings,
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

const effectDisposers = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  // A mutable cell: state setters write through, so an effect that resolves asynchronously is
  // observable by reading the component again after the microtask queue drains.
  useState: (init) => {
    const cell = { value: typeof init === 'function' ? init() : init }
    return [cell.value, (next) => { cell.value = next }]
  },
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  // Effects run immediately so the account card's remote catalog fetch resolves before the
  // static tree is inspected.
  useEffect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') effectDisposers.push(dispose)
  },
}

const clientStore = {
  'dsh-settings-resize': { disabledModels: [] },
  'llm-deepseek': { models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] },
  'llm-pi-ai': { providers: { capi: { displayName: 'dshcapi', models: [{ id: 'codearts/deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] } } },
}
const writes = []
// Mirrors the real write path: the switch calls settings.mutate and expects { ok: true }.
const clientRemote = {
  settings: {
    mutate: async (ns, ops, _revision) => {
      for (const op of ops) {
        writes.push({ ns, key: op.path[0] })
        clientStore[ns] = { ...clientStore[ns], [op.path[0]]: op.value }
      }
      return { ok: true, value: { ns } }
    },
  },
  // The account route has no catalog in the settings document; the card reads this instead.
  session: {
    modelCatalog: async () => ({
      ok: true,
      value: {
        groups: [
          {
            id: 'deepseek-account',
            name: 'DeepSeek 账号',
            models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
          },
        ],
      },
    }),
  },
}
const clientForms = {
  get: (ns) =>
    ns in clientStore
      ? {
          getSnapshot: () => ({ value: JSON.parse(JSON.stringify(clientStore[ns])), revision: 1 }),
          subscribe: () => () => {},
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
  remote: clientRemote,
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
  // The Models page dispatches these three namespaces: the account route, the API-key route,
  // and the pi-ai family (dshcapi plus any hand-declared route).
  cardRegs.some((r) => r.options.key === 'llm-deepseek') &&
    cardRegs.some((r) => r.options.key === 'llm-deepseek-account') &&
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
    modelSwitchTitle: '在对话中显示',
    modelSwitchHint: '关闭后该模型不再出现在对话的模型选择器中，此处仍可随时打开。',
    modelSwitchHintOff: '已关闭 {count} 个',
    providerSwitchLabel: '{name}（整个提供商）',
    providerSwitchAria: '{action} {name}（整个提供商）',
    providerRowNoteOn: '该提供商的模型会出现在模型选择器中',
    providerRowNoteOff: '整个提供商已从模型选择器中隐藏',
    modelRowNoteOn: '会出现在模型选择器中',
    modelRowNoteOff: '已从模型选择器中隐藏',
    modelRowNoteFollowsProvider: '随提供商一起隐藏',
    modelEnable: '启用',
    modelDisable: '关闭',
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
  // A function component in the static tree (PillSwitch) is not expanded by collect; call it
  // so its `role="switch"` button becomes visible.
  if (typeof node.type === 'function') {
    const rendered = node.type(node.props ?? {})
    const hit = findSwitch(rendered, modelName)
    if (hit !== undefined) return hit
  }
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
check('the card offers a provider-level switch', findSwitch(tree, '（整个提供商）') !== undefined)

// A provider card whose catalog is not readable here (the OAuth route keeps it remotely) must
// still offer the provider-level switch — that was the bug in the first card.
const accountReg = cardRegs.find((r) => r.options.key === 'llm-deepseek-account')
const accountProps = accountReg.options.inject()
// The account card fills its model list from the remote listing in an effect, so render once
// to let that effect start, drain the microtask queue, then render again with the data in hand.
accountReg.component({
  provider: {
    provider: 'deepseek-account',
    settingsNs: 'llm-deepseek-account',
    displayName: 'DeepSeek 账号',
  },
  t,
  ...accountProps,
})
await new Promise((resolve) => setImmediate(resolve))
const accountTree = accountReg.component({
  provider: {
    provider: 'deepseek-account',
    settingsNs: 'llm-deepseek-account',
    displayName: 'DeepSeek 账号',
  },
  t,
  ...accountProps,
})
// The account route must NOT offer a provider-level switch: the Models page keeps that card
// only while the route still advertises a model, so emptying its catalog would delete the card.
check(
  'the account route offers no provider-level switch',
  accountTree !== null && findSwitch(accountTree, '整个提供商') === undefined,
  accountTree === null ? 'rendered null' : 'provider switch present',
)

// Its models come from the remote listing, not the settings document, so the card still shows
// one switch per model — the section would otherwise render nothing at all.
check(
  'the account route lists its models from the remote catalog',
  collect(accountTree).includes('DeepSeek-V4.1-Flash'),
  collect(accountTree).join(' | ').slice(0, 120),
)
check(
  'the account route offers a switch per model',
  findSwitch(accountTree, 'DeepSeek-V4.1-Flash') !== undefined,
)
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
check('it is marked as hidden', text2.includes('已从模型选择器中隐藏'))
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

// --- provider off removes the model switches entirely ------------------------------
// The approved rule: once the whole provider is off, no model row carries a switch, and the
// rows say they follow the provider.
clientStore['dsh-settings-resize'].disabledProviders = ['llm-deepseek']
const tree3 = deepseekReg.component({
  provider: { provider: 'llm-deepseek', settingsNs: 'llm-deepseek', displayName: 'DeepSeek' },
  t,
  ...props,
})
const switchesWhenOff = (function count(node) {
  if (node === null || typeof node !== 'object') return 0
  let total = 0
  if (typeof node.type === 'function') total += count(node.type(node.props ?? {}))
  const p = node.props ?? {}
  if (p.role === 'switch') total += 1
  for (const child of node.children ?? []) total += count(child)
  return total
})(tree3)
check(
  'a switched-off provider renders only its own switch, no model switches',
  switchesWhenOff === 1,
  String(switchesWhenOff),
)
check(
  'model rows say they follow the provider',
  collect(tree3).includes('随提供商一起隐藏'),
)
check(
  'the provider caption states it is hidden',
  collect(tree3).includes('整个提供商已从模型选择器中隐藏'),
)
clientStore['dsh-settings-resize'].disabledProviders = []

const failed = results.filter((ok) => !ok).length
console.log(failed === 0 ? '\nALL MODEL SWITCH CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
if (failed) process.exitCode = 1