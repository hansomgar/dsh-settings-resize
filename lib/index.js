/**
 * Host half of dsh-settings-resize.
 *
 * Two independent features:
 *
 * 1. **Settings dialog size/transparency** — browser-only; this row exists so the package is a
 *    Loader entry at all, which is what makes the Web GUI publish `./client`.
 *
 * 2. **Model and provider switches** — lives here, because hiding a model (or a whole
 *    provider) from the *conversation* model picker has to happen where the picker reads its
 *    catalog.
 *
 * ## Why the picker is filtered here rather than by editing the catalog
 *
 * `Settings → Models` renders each provider's model rows from the settings document, while the
 * conversation picker and the `/model` popup both read `buildModelCatalog()`, which calls
 * `ctx.llm.listModels(provider)` and `ctx.llm.listProviders()`. Those are different sources.
 *
 * Editing the settings document would therefore change both surfaces. Wrapping the registry
 * changes only the picker path: a switched-off model — or a switched-off provider, which also
 * disappears from the picker's provider list — vanishes from every picker while the Settings
 * page keeps listing everything, which is exactly the requested behaviour.
 *
 * The wrappers are installed on the live registry and removed by their disposers, so disabling
 * the plugin restores the picker without touching any stored configuration.
 */
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-settings-resize'

/**
 * Services this plugin needs before `apply` runs.
 *
 * `llm` is the one that matters: the whole model filter is a wrapper around the live registry's
 * `listModels`/`listProviders`. Reading it with `ctx.get('llm')` and returning early when it is
 * absent made the plugin a no-op whenever it happened to start before the LLM runtime — the
 * switches stored their state, the UI showed it, and the picker kept listing everything.
 * Declaring the dependency makes the loader hold this row until the registry exists.
 */
export const inject = ['llm', 'settings']

/**
 * Settings namespace holding the switch state.
 *
 * A `Config` export is what makes this namespace exist at all: without it the settings
 * provider never serves it, `configForms.get()` returns undefined in the browser, and every
 * switch silently reads as "on" because nothing can be stored.
 *
 * Both fields must be `.volatile()`: the settings service only persists volatile fields, and a
 * write to a namespace with none is refused with
 * `Plugin entry "<id>" has no volatile fields`. `.default([])` alone is not enough — it makes
 * the field readable but not writable.
 */
export const Config = z.object({
  /** Models hidden from the conversation picker, as `<provider>` + `<modelId>`. */
  disabledModels: z
    .array(
      z.object({
        provider: z.string(),
        modelId: z.string(),
      }),
    )
    .default([])
    .volatile(),

  /** Providers hidden from the conversation picker entirely, including official ones. */
  disabledProviders: z.array(z.string()).default([]).volatile(),
})

/** Event an adapter/registry change is announced on; used to nudge pickers to re-read. */
const MODELS_UPDATED = 'llm/models-updated'

/** Event the settings provider emits after any namespace is written. */
const SETTINGS_UPDATED = 'settings/document-updated'

/**
 * Stable key for one model route.
 *
 * @param provider - provider route id.
 * @param modelId - model id inside that route.
 * @returns the key both the list and the wrappers use.
 */
function modelKey(provider, modelId) {
  return provider + '\u0000' + modelId
}

/**
 * Read the switch state.
 *
 * @param settings - the settings service.
 * @returns the hidden model keys and the hidden provider ids.
 */
function readState(settings) {
  const descriptor = settings.describe().find((entry) => entry.ns === name)
  const value = descriptor?.value ?? {}

  const models = Array.isArray(value.disabledModels) ? value.disabledModels : []
  const providers = Array.isArray(value.disabledProviders) ? value.disabledProviders : []

  return {
    models: new Set(
      models
        .filter((entry) => typeof entry?.provider === 'string' && typeof entry?.modelId === 'string')
        .map((entry) => modelKey(entry.provider, entry.modelId)),
    ),
    providers: new Set(providers.filter((id) => typeof id === 'string')),
  }
}

/**
 * Persist the switch state.
 *
 * @param settings - the settings service.
 * @param state - the state to store.
 */
async function writeState(settings, state) {
  const disabledModels = [...state.models]
    .map((key) => {
      const [provider, modelId] = key.split('\u0000')
      return { provider, modelId }
    })
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId),
    )
  await settings.update(name, {
    disabledModels,
    disabledProviders: [...state.providers].sort(),
  })
}

/**
 * Resolve the live LLM registry the picker reads.
 *
 * `ctx.llm` is a Cordis service proxy. Its `set` trap forwards to the real instance, so
 * assigning here does reach the registry; `symbols.original` is preferred when available
 * because it skips the proxy's property shadowing entirely.
 *
 * @param ctx - host plugin context; `llm` is a declared dependency, so it is present here.
 * @returns the object to patch.
 */
function liveRegistry(ctx) {
  const llm = ctx.llm
  const original = llm?.[Symbol.for('cordis.original')]
  return original ?? llm
}

/**
 * Install both filters.
 *
 * Re-applying (an HMR reload, or a second generation before the first is disposed) must not
 * stack wrappers: the outermost one remembers the original function on the registry, and a new
 * install reuses it. Both wrappers read through `state` on every call, so switching needs no
 * reinstallation.
 *
 * @param registry - the live LLM registry.
 * @param state - holder whose sets are replaced when the switches change.
 * @returns a disposer restoring the original methods.
 */
function installFilters(registry, state) {
  const INSTALLED_MODELS = Symbol.for('dsh-settings-resize.listModels')
  const SHARED_STATE = Symbol.for('dsh-settings-resize.state')

  const previousModels = registry[INSTALLED_MODELS] ?? registry.listModels
  if (typeof previousModels !== 'function') {
    return () => {}
  }

  // One shared holder, so a re-install keeps filtering with the newest state.
  const shared = registry[SHARED_STATE] ?? state
  registry[SHARED_STATE] = shared

  /*
   * Only `listModels` is wrapped, never `listProviders`.
   *
   * `Settings → Models` renders one card per provider from `llm.listProviders()`, so hiding a
   * provider there would remove the very card the switch lives on. The conversation picker
   * instead builds its groups from `listModels(provider)` and drops empty ones —
   * `buildModelCatalog` ends with `.filter((group) => group.models.length > 0)` — so reporting
   * no models is enough to remove a provider from every picker.
   *
   * ## Why the account route is exempt from the provider-level switch
   *
   * The Models page keeps an account row only when the route still advertises a model:
   *
   *   s.rows = rows.filter((row) =>
   *     row.entry.provider !== 'deepseek-account' || row.accountAvailable === true)
   *
   * and `accountAvailable` is exactly "this route's catalog group has at least one model". A
   * provider-level switch on `deepseek-account` would therefore delete its own card — there is
   * no way to empty the picker while keeping the row, because both read the same catalog.
   * Its models can still be switched off one by one, which leaves the card in place.
   */
  const ACCOUNT_PROVIDER = 'deepseek-account'

  const patchedModels = async function listModels(provider) {
    const models = await previousModels.call(this, provider)
    const hidden = shared.state
    // A hidden provider reports no models, which is what removes it from the pickers. The
    // account route is excluded: emptying it would drop its own Settings card.
    if (provider !== ACCOUNT_PROVIDER && hidden.providers.has(provider)) return []
    if (!Array.isArray(models) || hidden.models.size === 0) return models
    return models.filter((model) => !hidden.models.has(modelKey(provider, model?.id)))
  }

  registry[INSTALLED_MODELS] = previousModels
  registry.listModels = patchedModels

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // Only undo our own wrapper; another plugin may have wrapped on top.
    if (registry.listModels === patchedModels) registry.listModels = previousModels
    delete registry[INSTALLED_MODELS]
    delete registry[SHARED_STATE]
  }
}

export function apply(ctx) {
  // Both are declared dependencies, so the loader guarantees them before this runs. No early
  // return: a silent no-op here is what made the switches store state that never applied.
  const settings = ctx.settings
  const registry = liveRegistry(ctx)

  /** Holder so the wrappers always see the current switch state. */
  const holder = { state: readState(settings) }

  const publish = () => {
    // Tell resident pickers to re-read; they refetch on this event.
    try {
      ctx.emit(MODELS_UPDATED)
    } catch {
      // A composition without listeners needs no announcement.
    }
  }

  ctx.effect(
    () => installFilters(registry, holder),
    'dsh-settings-resize: picker filters',
  )

  // Keep the in-memory state current when any window writes the switches.
  ctx.effect(
    () =>
      ctx.on(SETTINGS_UPDATED, () => {
        holder.state = readState(settings)
        publish()
      }),
    'dsh-settings-resize: switch subscription',
  )

  /**
   * The command surface the Client half drives.
   *
   * Every call replaces `holder.state`, persists it, and announces the change so open pickers
   * refetch.
   */
  ctx.effect(
    () =>
      ctx.provide('dshSettingsResizeModels', {
        /** @returns the current switch state. */
        list: () => ({
          models: [...holder.state.models].map((key) => {
            const [provider, modelId] = key.split('\u0000')
            return { provider, modelId }
          }),
          providers: [...holder.state.providers],
        }),

        /** Hide or reveal one model. */
        setModel: async (request) => {
          const provider = request?.provider
          const modelId = request?.modelId
          if (typeof provider !== 'string' || typeof modelId !== 'string') {
            return { ok: false, reason: 'invalid' }
          }
          const key = modelKey(provider, modelId)
          const models = new Set(holder.state.models)
          if (request.enabled === false) models.add(key)
          else models.delete(key)
          holder.state = { models, providers: holder.state.providers }
          await writeState(settings, holder.state)
          publish()
          return { ok: true }
        },

        /** Hide or reveal one provider, official ones included. */
        setProvider: async (request) => {
          const provider = request?.provider
          if (typeof provider !== 'string' || provider.length === 0) {
            return { ok: false, reason: 'invalid' }
          }
          const providers = new Set(holder.state.providers)
          if (request.enabled === false) providers.add(provider)
          else providers.delete(provider)
          holder.state = { models: holder.state.models, providers }
          await writeState(settings, holder.state)
          publish()
          return { ok: true }
        },

        /** Reveal everything. Also the recovery path after an unexpected state. */
        restoreAll: async () => {
          const count = holder.state.models.size + holder.state.providers.size
          holder.state = { models: new Set(), providers: new Set() }
          await writeState(settings, holder.state)
          publish()
          return { ok: true, restored: count }
        },
      }),
    'dsh-settings-resize: switch service',
  )
}
