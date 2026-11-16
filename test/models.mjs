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
      { id: 'deepseek-account', name: 'DeepSeek 账号' },
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'capi', name: 'dshcapi' },
    ]
  },
}

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

// `listProviders` is wrapped, but only to drop the account route: every other provider keeps
// its Settings card and is hidden through listModels instead.
check(
  'listProviders keeps every non-account provider',
  (await registry.listProviders()).some((p) => p.id === 'deepseek') &&
    (await registry.listProviders()).some((p) => p.id === 'capi'),
  JSON.stringify((await registry.listProviders()).map((p) => p.id)),
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
  'the Host leaves listModels untouched so every Settings card keeps its models',
  (await pickerIds('deepseek')).length === 2,
  JSON.stringify(await pickerIds('deepseek')),
)

// --- the Host stores the switches and announces changes --------------------------
await service.setModel({ provider: 'deepseek', modelId: 'deepseek-v4-pro', enabled: false })
check(
  'a model switch is stored in the plugin namespace',
  store['dsh-settings-resize'].disabledModels.some(
    (e) => e.provider === 'deepseek' && e.modelId === 'deepseek-v4-pro',
  ),
  JSON.stringify(store['dsh-settings-resize'].disabledModels),
)
check(
  'the Host still reports that model, so the Models page keeps it',
  (await pickerIds('deepseek')).includes('deepseek-v4-pro'),
  JSON.stringify(await pickerIds('deepseek')),
)
check(
  'a models-updated event is announced',
  emitted.includes('llm/models-updated'),
  JSON.stringify(emitted),
)
await service.setModel({ provider: 'deepseek', modelId: 'deepseek-v4-pro', enabled: true })
check(
  'turning it back on clears the record',
  store['dsh-settings-resize'].disabledModels.length === 0,
  JSON.stringify(store['dsh-settings-resize'].disabledModels),
)

// --- a provider switch is stored the same way ------------------------------------
await service.setProvider({ provider: 'capi', enabled: false })
check(
  'a provider switch is stored for the Client to apply',
  store['dsh-settings-resize'].disabledProviders.includes('capi'),
  JSON.stringify(store['dsh-settings-resize'].disabledProviders),
)
check(
  'the Host keeps reporting the provider, so its card stays',
  (await registry.listProviders()).some((p) => p.id === 'capi'),
  JSON.stringify((await registry.listProviders()).map((p) => p.id)),
)
await service.setProvider({ provider: 'capi', enabled: true })

// --- restoreAll ------------------------------------------------------------------
await service.setModel({ provider: 'deepseek', modelId: 'deepseek-flash', enabled: false })
check(
  'a model switch is recorded before uninstall',
  store['dsh-settings-resize'].disabledModels.some((e) => e.modelId === 'deepseek-flash'),
  JSON.stringify(store['dsh-settings-resize'].disabledModels),
)

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
// The picker's catalog directory. The plugin wraps this store, which is the only surface the
// conversation picker reads; `Settings → Models` calls the remote directly, so it is untouched.
let pickerCatalog = { groups: [] }
const pickerStore = {
  set(patch) {
    if (patch !== null && typeof patch === 'object' && 'value' in patch) pickerCatalog = patch.value
  },
  update(mutator) {
    const result = mutator(pickerCatalog)
    if (result !== undefined) pickerCatalog = result
  },
  getSnapshot: () => ({ value: pickerCatalog, status: 'ready', error: null }),
  subscribe: () => () => {},
}

const clientCtx = {
  effect: (fn) => fn(),
  get: () => undefined,
  configForms: clientForms,
  remote: clientRemote,
  modelDirectories: { catalog: { store: pickerStore } },
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: {
    inject: (key, cb) => cb(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

const clientExports = mods[0].factory(() => React)
clientExports.apply(clientCtx)

// --- the picker catalog is filtered in the browser -------------------------------
// This is the fix for "only the account card disappears": the Host keeps reporting every model,
// so the Models page still sees all three cards, while the picker never shows a hidden entry.
clientStore['dsh-settings-resize'].disabledModels = [{ provider: 'deepseek', modelId: 'deepseek-v4-pro' }]
clientStore['dsh-settings-resize'].disabledProviders = ['capi']
pickerStore.set({
  value: {
    groups: [
      { id: 'deepseek', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
      { id: 'capi', models: [{ id: 'capi-flash' }] },
    ],
  },
})
check(
  'the picker drops a switched-off model',
  pickerCatalog.groups.length === 1 &&
    pickerCatalog.groups[0].models.length === 1 &&
    pickerCatalog.groups[0].models[0].id === 'deepseek-flash',
  JSON.stringify(pickerCatalog.groups),
)
check(
  'the picker drops a switched-off provider',
  !pickerCatalog.groups.some((g) => g.id === 'capi'),
  JSON.stringify(pickerCatalog.groups.map((g) => g.id)),
)

// The account route is the case that used to break: hiding its last model must empty the picker
// without emptying the Host catalog, because the Settings card depends on that catalog.
clientStore['dsh-settings-resize'].disabledModels = [
  { provider: 'deepseek-account', modelId: 'deepseek-flash' },
]
clientStore['dsh-settings-resize'].disabledProviders = []
pickerStore.set({
  value: { groups: [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] }] },
})
check(
  'the picker drops the account route\u2019s last model',
  pickerCatalog.groups.length === 0,
  JSON.stringify(pickerCatalog.groups),
)
check(
  'the Host catalog still lists it, so the Settings card survives',
  (await pickerIds('deepseek-account')).length === 1,
  JSON.stringify(await pickerIds('deepseek-account')),
)
clientStore['dsh-settings-resize'].disabledModels = []
clientStore['dsh-settings-resize'].disabledProviders = []
pickerCatalog = { groups: [] }

const cardRegs = registrations.filter((r) => r.options.name === 'settings.models.provider-card')
check('registers switches on the provider-card slot', cardRegs.length > 0, String(cardRegs.length))

// Every remote namespace the component touches must be a declared dependency. A missing key
// throws at the first call, and a catch around it turns the card into a silent blank.
const declaredInject = JSON.stringify(clientExports.inject ?? [])
check(
  'the client declares both remote namespaces it calls',
  declaredInject.includes('"remote.settings"') && declaredInject.includes('"remote.session"'),
  declaredInject,
)
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
    modelEnableAll: '全部启用',
    modelDisableAll: '全部关闭',
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
check('the card offers no provider-level switch', findSwitch(tree, '（整个提供商）') === undefined)

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
// The account route offers no provider-level switch: the Models page drops that card as soon as
// its catalog group is empty, and the picker drops the group for the same reason. It gets a bulk
// model action instead, which empties the group without touching the card.
check(
  'the account route offers no provider-level switch',
  accountTree !== null && findSwitch(accountTree, '整个提供商') === undefined,
  accountTree === null ? 'rendered null' : 'provider switch present',
)
check(
  'the account route lists only model switches',
  accountTree !== null &&
    findSwitch(accountTree, '整个提供商') === undefined &&
    findSwitch(accountTree, 'DeepSeek-V4.1-Flash') !== undefined,
  accountTree === null ? 'rendered null' : 'unexpected control',
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

// --- a provider entry no longer controls the UI -------------------------------
// Providers are hidden by switching their models off, so a leftover provider entry must not
// change what the card renders.
clientStore['dsh-settings-resize'].disabledProviders = ['llm-deepseek']
const tree3 = deepseekReg.component({
  provider: { provider: 'llm-deepseek', settingsNs: 'llm-deepseek', displayName: 'DeepSeek' },
  t,
  ...props,
})
check(
  'a provider entry does not remove the model switches',
  findSwitch(tree3, 'DeepSeek-V4-Pro') !== undefined,
)
clientStore['dsh-settings-resize'].disabledProviders = []

const failed = results.filter((ok) => !ok).length
console.log(failed === 0 ? '\nALL MODEL SWITCH CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
if (failed) process.exitCode = 1