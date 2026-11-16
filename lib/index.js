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
 * The OAuth-backed account route.
 *
 * Its Settings card has an extra guard the other routes do not: the row is dropped unless
 * `buildModelCatalog` produced a non-empty group for it, and that catalog is built from
 * `listProviders` + `listModels`. Emptying either one therefore deletes the card, which is why
 * a provider-level switch on this route is expanded into per-model hides instead of filtering
 * at the registry.
 */
const ACCOUNT_PROVIDER = 'deepseek-account'

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
 * Read one route's models straight from the registry, bypassing the picker filter.
 *
 * The account-route provider switch needs the unfiltered list so it can expand into exact model
 * keys; asking the wrapped `listModels` would return whatever is already filtered out.
 *
 * @param registry - the live LLM registry.
 * @param provider - provider route id.
 * @returns the adapter's own list, or an empty array when it cannot be read.
 */
async function previousModelsFor(registry, provider) {
  const original = registry[Symbol.for('dsh-settings-resize.listModels')] ?? registry.listModels
  try {
    const models = await original.call(registry, provider)
    return Array.isArray(models) ? models : []
  } catch {
    return []
  }
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
  const INSTALLED_PROVIDERS = Symbol.for('dsh-settings-resize.listProviders')
  const SHARED_STATE = Symbol.for('dsh-settings-resize.state')

  const previousModels = registry[INSTALLED_MODELS] ?? registry.listModels
  const previousProviders = registry[INSTALLED_PROVIDERS] ?? registry.listProviders
  if (typeof previousModels !== 'function' || typeof previousProviders !== 'function') {
    return () => {}
  }

  // One shared holder, so a re-install keeps filtering with the newest state.
  const shared = registry[SHARED_STATE] ?? state
  registry[SHARED_STATE] = shared

  /*
   * Only `listModels` is wrapped. `listProviders` stays untouched.
   *
   * The conversation picker builds its groups from `listModels(provider)` and drops empty ones
   * (`buildModelCatalog` ends with `.filter((group) => group.models.length > 0)`), so reporting
   * no models removes a provider from every picker. `Settings → Models` instead renders one card
   * per entry in `listProviders`, so wrapping that list would delete the cards themselves.
   *
   * ## The account route
   *
   * Its card has an extra guard:
   *
   *   s.rows = rows.filter((row) =>
   *     row.entry.provider !== 'deepseek-account' || row.accountAvailable === true)
   *
   * and `accountAvailable` is "`buildModelCatalog` produced a non-empty group for this route" —
   * which itself starts from `listProviders`. Both emptying `listModels` and wrapping
   * `listProviders` therefore make the card disappear, on the first render or on the next
   * reload.
   *
   * So the provider-level switch on this route does not filter anything at the registry level.
   * It is expanded by the caller into "hide every model of this provider", which the ordinary
   * per-model filter already handles: the group empties, every picker loses it, and
   * `accountAvailable` stays true because the route still lists models.
   */
  const patchedModels = async function listModels(provider) {
    const models = await previousModels.call(this, provider)
    const hidden = shared.state
    if (!Array.isArray(models)) return models

    /*
     * A provider switched off as a whole reports no models. That is what removes it from every
     * picker, because `buildModelCatalog` drops groups whose model list is empty.
     *
     * The account route is special: its Settings card is dropped as soon as its catalog group
     * is empty, so emptying it here would delete the card. `setProvider` therefore expands that
     * switch into per-model hides instead of adding a provider entry, and this branch is
     * skipped for it. If an entry is nonetheless present (a list written by an older build),
     * it is honoured by the per-model filter below rather than ignored.
     */
    if (provider !== ACCOUNT_PROVIDER && hidden.providers.has(provider)) return []
    if (hidden.models.size === 0) return models
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

  /*
   * Migrate a list written by an older build.
   *
   * Those builds recorded the account route in `disabledProviders`. That entry no longer has
   * any effect on the route itself (see `setProvider`), and leaving it behind would show the
   * provider switch as off while its models still reached the pickers. Rewriting it as the
   * per-model hides it was meant to represent makes the stored state match what the UI shows.
   */
  void (async () => {
    if (!holder.state.providers.has(ACCOUNT_PROVIDER)) return
    const listed = await previousModelsFor(registry, ACCOUNT_PROVIDER)
    if (listed.length === 0) return
    const models = new Set(holder.state.models)
    for (const model of listed) {
      if (typeof model?.id === 'string') models.add(modelKey(ACCOUNT_PROVIDER, model.id))
    }
    const providers = new Set(holder.state.providers)
    providers.delete(ACCOUNT_PROVIDER)
    holder.state = { models, providers }
    try {
      await writeState(settings, holder.state)
      publish()
    } catch {
      // A read-only deployment keeps the old list; the per-model filter still applies it.
    }
  })()

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
          const models = new Set(holder.state.models)

          if (provider === ACCOUNT_PROVIDER) {
            /*
             * This route cannot be filtered at the registry: both `listModels` and
             * `listProviders` feed the availability check that keeps its Settings card, so
             * either one emptying makes the card vanish on the next load.
             *
             * Instead the switch is expanded here into per-model hides. The route keeps
             * advertising models (so the card stays), while the catalog group becomes empty
             * and every picker drops it.
             */
            const listed = await previousModelsFor(registry, provider)
            if (request.enabled === false) {
              for (const model of listed) {
                if (typeof model?.id === 'string') models.add(modelKey(provider, model.id))
              }
            } else {
              for (const model of listed) {
                if (typeof model?.id === 'string') models.delete(modelKey(provider, model.id))
              }
            }
            providers.delete(provider)
            holder.state = { models, providers }
            await writeState(settings, holder.state)
            publish()
            return { ok: true }
          }

          if (request.enabled === false) providers.add(provider)
          else providers.delete(provider)
          holder.state = { models, providers }
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
