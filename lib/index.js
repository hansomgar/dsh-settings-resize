/**
 * Host half of dsh-settings-resize.
 *
 * Two independent features:
 *
 * 1. **Settings dialog size/transparency** — browser-only; this row exists so the package is a
 *    Loader entry at all, which is what makes the Web GUI publish `./client`.
 *
 * 2. **Model switches** — lives here, because hiding a model from the *conversation* model
 *    picker has to happen where the picker reads its catalog.
 *
 * ## Why the picker is filtered here rather than by editing the catalog
 *
 * `Settings → Models` renders each provider's model rows from the settings document, while the
 * conversation picker and the `/model` popup both read `buildModelCatalog()`, which calls
 * `ctx.llm.listModels(provider)`. Those are two different sources.
 *
 * Editing the settings document would therefore change both surfaces. Wrapping `listModels`
 * changes only the picker path: a model switched off disappears from every picker while the
 * Settings page keeps listing it, which is exactly the requested behaviour.
 *
 * The wrapper is installed on the live registry and removed by its disposer, so disabling the
 * plugin restores the picker without touching any stored configuration.
 */
export const name = 'dsh-settings-resize'

/** Settings namespace holding the disabled-model list. */
const NS = 'dsh-settings-resize'

/** Event an adapter/registry change is announced on; used to nudge pickers to re-read. */
const MODELS_UPDATED = 'llm/models-updated'

/** Event the settings provider emits after any namespace is written. */
const SETTINGS_UPDATED = 'settings/document-updated'

/**
 * Stable key for one model route.
 *
 * @param provider - provider route id.
 * @param modelId - model id inside that route.
 * @returns the key both the list and the wrapper use.
 */
function modelKey(provider, modelId) {
  return provider + '\u0000' + modelId
}

/**
 * Read the disabled-model list from the plugin's own settings namespace.
 *
 * @param settings - the settings service.
 * @returns a Set of `provider\u0000modelId` keys.
 */
function readDisabled(settings) {
  const descriptor = settings.describe().find((entry) => entry.ns === NS)
  const list = descriptor?.value?.disabledModels
  if (!Array.isArray(list)) return new Set()
  return new Set(
    list
      .filter((entry) => typeof entry?.provider === 'string' && typeof entry?.modelId === 'string')
      .map((entry) => modelKey(entry.provider, entry.modelId)),
  )
}

/**
 * Persist the disabled-model list.
 *
 * @param settings - the settings service.
 * @param keys - keys to store, in stable order.
 */
async function writeDisabled(settings, keys) {
  const disabledModels = [...keys]
    .map((key) => {
      const [provider, modelId] = key.split('\u0000')
      return { provider, modelId }
    })
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId),
    )
  await settings.update(NS, { disabledModels })
}

/**
 * Resolve the live LLM registry the picker reads.
 *
 * `ctx.llm` is a Cordis service proxy. Its `set` trap forwards to the real instance, so
 * assigning `listModels` here does reach the registry; `symbols.original` is preferred when
 * available because it skips the proxy's property shadowing entirely.
 *
 * @param ctx - host plugin context.
 * @returns the object to patch, or undefined when no LLM registry is mounted.
 */
function liveRegistry(ctx) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null) return undefined
  const original = llm[Symbol.for('cordis.original')]
  return original ?? llm
}

/**
 * Install the picker filter.
 *
 * The wrapper reads through `state` on every call rather than capturing the Set, because
 * `restoreAll` and the settings event both replace it wholesale.
 *
 * Re-applying (an HMR reload, or a second generation before the first is disposed) must not
 * stack wrappers: each extra layer would filter the already-filtered result and, worse, only
 * one of them would be undone on unload. The outermost wrapper therefore remembers the
 * original function on the registry itself, and a new install reuses it.
 *
 * @param registry - the live LLM registry.
 * @param state - holder whose `disabled` set is replaced when the list changes.
 * @returns a disposer restoring the original `listModels`.
 */
function installFilter(registry, state) {
  const INSTALLED = Symbol.for('dsh-settings-resize.listModels')
  const INSTALLED_STATE = Symbol.for('dsh-settings-resize.listModels.state')
  const previous = registry[INSTALLED] ?? registry.listModels
  if (typeof previous !== 'function') return () => {}

  // Publish our state through one shared holder so a re-install keeps filtering with the
  // newest set without adding a layer.
  const shared = registry[INSTALLED_STATE] ?? state
  registry[INSTALLED_STATE] = shared

  const patched = async function listModels(provider) {
    const models = await previous.call(this, provider)
    const disabled = shared.disabled
    if (!Array.isArray(models) || disabled.size === 0) return models
    return models.filter((model) => !disabled.has(modelKey(provider, model?.id)))
  }

  // Remember what to restore to, then override whatever is currently installed.
  registry[INSTALLED] = previous
  registry.listModels = patched

  return () => {
    // Only undo our own wrapper; another plugin may have wrapped on top of it.
    if (registry.listModels !== patched) return
    registry.listModels = previous
    // Drop the bookkeeping so a later install starts from the restored function.
    delete registry[INSTALLED]
    delete registry[INSTALLED_STATE]
  }
}

export function apply(ctx, config) {
  const settings = ctx.get('settings')
  const registry = liveRegistry(ctx)
  if (settings === undefined || registry === undefined) return

  /** Holder so the wrapper always sees the current list after a restore or a settings event. */
  const state = { disabled: readDisabled(settings) }

  const publish = () => {
    // Tell resident pickers to re-read; they refetch on this event.
    try {
      ctx.emit(MODELS_UPDATED)
    } catch {
      // A composition without listeners needs no announcement.
    }
  }

  ctx.effect(
    () => installFilter(registry, state),
    'dsh-settings-resize: picker filter',
  )

  // Track writes made by the Client half (or by another window) without re-reading on every
  // `listModels` call. The settings provider announces every namespace write, so the disabled
  // set stays current without polling.
  ctx.effect(
    () =>
      ctx.on(SETTINGS_UPDATED, () => {
        state.disabled = readDisabled(settings)
        publish()
      }),
    'dsh-settings-resize: disabled list subscription',
  )

  /**
   * The command surface the Client half drives.
   *
   * Each call replaces `state.disabled`, persists it, and announces the change so every open
   * picker refetches.
   */
  ctx.effect(
    () =>
      ctx.provide('dshSettingsResizeModels', {
        /** @returns the hidden keys, so a panel can render switch state. */
        list: () => ({
          disabled: [...state.disabled].map((key) => {
            const [provider, modelId] = key.split('\u0000')
            return { provider, modelId }
          }),
        }),
        /** Hide or reveal one model. */
        set: async (request) => {
          const provider = request?.provider
          const modelId = request?.modelId
          if (typeof provider !== 'string' || typeof modelId !== 'string') {
            return { ok: false, reason: 'invalid' }
          }
          const key = modelKey(provider, modelId)
          // Copy rather than mutate, so a reader mid-flight keeps a coherent set.
          const next = new Set(state.disabled)
          if (request.enabled === false) next.add(key)
          else next.delete(key)
          state.disabled = next
          await writeDisabled(settings, next)
          publish()
          return { ok: true }
        },
        /** Reveal every model. Also runs when the plugin is disabled. */
        restoreAll: async () => {
          const count = state.disabled.size
          state.disabled = new Set()
          await writeDisabled(settings, state.disabled)
          publish()
          return { ok: true, restored: count }
        },
      }),
    'dsh-settings-resize: model switch service',
  )
}
