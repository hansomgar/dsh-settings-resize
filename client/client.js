/**
 * Client half of dsh-settings-resize.
 *
 * The Settings dialog is `[data-shortcut-modal="settings"]`; its class is a CSS-modules
 * hash, so the panel is addressed by that stable attribute only. Three custom properties
 * on `html` drive its box and its surface, and this file owns them: the values come from
 * `localStorage` and from the sliders this plugin adds to the General settings page.
 *
 * Transparency fades the panel *surface* only, by mixing the surface token toward
 * `transparent`; text and controls keep full opacity, so a see-through dialog stays
 * readable.
 *
 * Everything that outlives a render (the style element, the three custom properties, the
 * slot registration) is created inside `ctx.effect`, so disabling or removing the plugin
 * restores the shipped 800×800 opaque dialog with no residue.
 */
window.__ModuleLoader__.load({
  id: 'dsh-settings-resize',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useRef, useState } = React

    const STORAGE_KEY = 'dsh.settingsResize.v1'
    const STYLE_ID = 'dsh-settings-resize-style'
    const VAR_WIDTH = '--dsh-settings-w'
    const VAR_HEIGHT = '--dsh-settings-h'
    const VAR_ALPHA = '--dsh-settings-alpha'
    const VAR_EDGE = '--dsh-settings-edge'

    /** Slider domains. The stored value is clamped to them on every read and write. */
    const WIDTH = { min: 640, max: 2400, step: 10, unit: 'px' }
    const HEIGHT = { min: 480, max: 2160, step: 10, unit: 'px' }
    // 100% leaves only the panel's own border and shadow, so the dialog edge and its close
    // button stay findable while the surface itself is fully see-through.
    const TRANSPARENCY = { min: 0, max: 100, step: 1, unit: '%' }

    /** The shipped dialog, and what 恢复默认 restores. */
    const DEFAULT_STATE = { width: 800, height: 800, heightUnit: 'px', transparency: 0 }

    /** Locale namespace, also the entry id in cordis.patch.yml. */
    const NS = 'dsh-settings-resize'

    /**
     * Key holding the dictionaries' disposer on `globalThis`.
     *
     * The locale service keeps one occupant per (namespace, language) and throws on a
     * duplicate, and it exposes no way to release a claim except the disposer `register`
     * returned. That disposer has to outlive this module: an HMR pass re-executes the
     * bundle, so a module-scoped variable resets while the previous generation's claim is
     * still live. Parking it on the global lets the next generation release it first.
     */
    const DISPOSER_KEY = '__dshSettingsResizeLocale'

    /*
     * ---------------------------------------------------------------------------------
     * Model on/off switches
     * ---------------------------------------------------------------------------------
     *
     * The switch belongs to each provider card on Settings → Models, next to Edit and
     * Remove, and it changes ONE thing: whether the conversation model picker offers that
     * model. The Settings page keeps listing every model, because its rows come from the
     * settings document while the picker reads `llm.listModels()`.
     *
     * The filtering itself runs on the Host (see lib/index.js): the Client only reads and
     * writes the list of switched-off routes through the plugin's own settings namespace,
     * which every surface can read.
     */

    /** This plugin's settings namespace, which holds the switched-off list. */
    const RECORD_NS = 'dsh-settings-resize'

    /**
     * Read the switch state from the plugin's own settings namespace.
     *
     * @param configForms - the client form registry.
     * @returns the hidden model keys and the hidden provider ids.
     */
    function readSwitchState(configForms) {
      const form = configForms.get(RECORD_NS)
      const value = form?.getSnapshot?.()?.value ?? {}
      const models = Array.isArray(value.disabledModels) ? value.disabledModels : []
      const providers = Array.isArray(value.disabledProviders) ? value.disabledProviders : []
      return {
        models: new Set(
          models
            .filter((entry) => typeof entry?.provider === 'string' && typeof entry?.modelId === 'string')
            .map((entry) => entry.provider + '\u0000' + entry.modelId),
        ),
        providers: new Set(providers.filter((id) => typeof id === 'string')),
      }
    }

    /**
     * Persist the switch state.
     *
     * The write goes through the settings Remote the Models page itself uses:
     * `ctx.remote.settings.mutate(ns, ops, revision)` answers `{ ok, value }`, and the mirror is
     * refreshed only on `ok`. Failure is therefore reportable instead of silent — a switch that
     * cannot be stored must say so rather than flip back without explanation.
     *
     * Both fields are written in one operation list, so the document never holds a state where
     * one list is updated and the other is stale.
     *
     * @param configForms - the client form registry.
     * @param remote - the Client remote face (`ctx.remote`).
     * @param state - the state to store.
     * @returns whether the write was accepted.
     */
    async function writeSwitchState(configForms, remote, state) {
      const form = configForms.get(RECORD_NS)
      if (form === undefined || form === null) throw new Error('settings namespace unavailable')

      const disabledModels = [...state.models]
        .map((key) => {
          const parts = key.split('\u0000')
          return { provider: parts[0], modelId: parts[1] }
        })
        .sort(
          (left, right) =>
            left.provider.localeCompare(right.provider) ||
            left.modelId.localeCompare(right.modelId),
        )
      const disabledProviders = [...state.providers].sort()

      const snapshot = form.getSnapshot()
      const settings = remote?.settings
      if (settings === undefined) throw new Error('settings remote unavailable')

      const response = await settings.mutate(
        RECORD_NS,
        [
          { op: 'set', path: ['disabledModels'], value: disabledModels },
          { op: 'set', path: ['disabledProviders'], value: disabledProviders },
        ],
        snapshot?.revision,
      )
      if (response?.ok !== true) {
        throw new Error(response?.error?.message ?? 'settings write rejected')
      }
      // Fold the accepted view into the shared mirror at once. `acceptView` lives on the
      // describe face (what `configForms.describe()` returns), not on a per-namespace form, and
      // it is optional: the forwarded `settings/document-updated` event refreshes the mirror
      // shortly after anyway, so a mirror without this method still converges.
      configForms.describe?.()?.acceptView?.(response.value)
      return true
    }

    /**
     * Read every model a provider currently offers, straight from its settings row.
     *
     * Both provider families keep the catalog in the settings document, and neither is read
     * through `listModels`, so the Settings page is unaffected by the picker filter.
     *
     * @param configForms - the client form registry.
     * @param settingsNs - namespace owning the provider's configuration.
     * @param provider - provider route id.
     * @returns `{ id, name }` rows in catalog order.
     */
    function modelsOfProvider(configForms, settingsNs, provider) {
      const form = configForms.get(settingsNs)
      if (form === undefined || form === null) return []
      const value = form.getSnapshot().value
      if (value === null || typeof value !== 'object') return []

      // A provider-less namespace (llm-deepseek) keeps one flat catalog; a pi-ai profile keeps
      // one catalog per provider id.
      const profile =
        value.providers !== null && typeof value.providers === 'object'
          ? value.providers[provider]
          : value
      const models = profile?.models
      if (!Array.isArray(models)) return []
      return models
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
        .map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }))
    }

    /**
     * One pill switch, matching the shape Settings uses elsewhere.
     *
     * @param props - `on`, `label`, `disabled`, `onChange`.
     */
    function PillSwitch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.on,
          'aria-label': props.label,
          className: 'dsh-settings-resize-switch',
          'data-on': props.on ? 'true' : undefined,
          disabled: props.disabled,
          onClick: props.onChange,
        },
        h('span', { 'aria-hidden': true }),
      )
    }

    /**
     * The switch block rendered inside one provider card.
     *
     * It offers a provider-level switch (which hides the whole provider from the conversation
     * picker) and one switch per model. Nothing is hidden on this page: the state of each row
     * is stated under its name, and the same gesture turns it back on.
     *
     * @param props - owner props (`provider`) plus `t` and the injected model controls.
     */
    function ProviderModelSwitches(props) {
      const { provider, t, configForms, remote } = props
      const settingsNs = provider?.settingsNs
      const providerId = provider?.provider
      const providedName = provider?.displayName
      const [state, setState] = useState(() => readSwitchState(configForms))
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const useEffect = React.useEffect

      const refresh = useCallback(() => {
        setState(readSwitchState(configForms))
      }, [configForms])

      useEffect(() => {
        const form = configForms.get(RECORD_NS)
        if (form === undefined || form === null) return () => {}
        const dispose = form.subscribe(refresh)
        refresh()
        return () => {
          try {
            dispose()
          } catch {
            // Disposed with its namespace.
          }
        }
      }, [configForms, refresh])

      const models = settingsNs === undefined ? [] : modelsOfProvider(configForms, settingsNs, providerId)

      const commit = useCallback(
        async (mutate, key) => {
          if (busy !== '') return
          setBusy(key)
          setNotice('')
          try {
            // Compose from a fresh read so two quick clicks cannot overwrite each other.
            const current = readSwitchState(configForms)
            const next = mutate(current)
            await writeSwitchState(configForms, remote, next)
            setState(next)
          } catch (error) {
            setNotice(t('modelWriteFailed', { message: String(error?.message ?? error) }))
          } finally {
            setBusy('')
          }
        },
        [busy, configForms, t],
      )

      /*
       * The provider switch is useful even when no model row can be listed: the OAuth route
       * keeps its catalog remotely, so `modelsOfProvider` finds nothing for it, yet hiding the
       * whole provider is still a meaningful action. Only a card with neither models nor a
       * provider identity renders nothing.
       */
      if (providerId === undefined) return null

      /*
       * The account route cannot be switched off as a whole.
       *
       * The Models page keeps its card only while that route still advertises a model, and the
       * card's availability is derived from the same catalog the picker reads. Emptying the
       * catalog would therefore delete the card itself, so this route offers per-model switches
       * only — switching off every model still removes the group from every picker.
       */
      const providerSwitchable = providerId !== 'deepseek-account'

      const providerOff = providerSwitchable && state.providers.has(providerId)
      const offCount = models.filter((model) => state.models.has(providerId + '\u0000' + model.id)).length

      /*
       * Layout follows the approved design:
       *
       *   [ card header: name · status · Edit · Delete        (provider switch) ]
       *   [ label: 对话中可见的模型 ]
       *   [ model name / note                                 (model switch)    ]
       *
       * The provider switch is the last control on the card's control line, so it lines up with
       * Edit and Delete. The slot itself renders below the header row, which is why this block
       * starts flush against it and repeats the alignment rather than sitting inside it.
       *
       * A provider that is switched off hides its model switches entirely: the rows stay (so the
       * configuration is still readable) but they carry no switch and say they follow the
       * provider.
       */
      return h(
        'div',
        { className: 'dsh-settings-resize-rowgroup', 'data-provider-off': providerOff ? 'true' : undefined },
        notice === ''
          ? null
          : h('div', { className: 'dsh-settings-resize-notice', role: 'status' }, notice),

        // The provider switch, right-aligned on its own line against the card controls above.
        // The account route has no provider-level switch; see `providerSwitchable`.
        providerSwitchable
          ? h(
              'div',
              { className: 'dsh-settings-resize-provider-row' },
              h(
                'span',
                { className: 'dsh-settings-resize-provider-caption' },
                providerOff ? t('providerRowNoteOff') : t('providerRowNoteOn'),
              ),
              h(PillSwitch, {
                on: !providerOff,
                label: t('providerSwitchAria', {
                  name: providedName ?? providerId,
                  action: providerOff ? t('modelEnable') : t('modelDisable'),
                }),
                disabled: busy !== '',
                onChange: () =>
                  commit(
                    (current) => {
                      const providers = new Set(current.providers)
                      if (providerOff) providers.delete(providerId)
                      else providers.add(providerId)
                      return { models: current.models, providers }
                    },
                    'provider',
                  ),
              }),
            )
          : null,

        // Model rows. A provider with no readable catalog shows none; one that is switched off
        // shows the rows without switches.
        models.length === 0
          ? null
          : h(
              'div',
              { className: 'dsh-settings-resize-rowgroup-label' },
              t('modelSwitchTitle'),
              offCount === 0 || providerOff
                ? null
                : h(
                    'span',
                    { className: 'dsh-settings-resize-rowgroup-count' },
                    t('modelSwitchHintOff', { count: offCount }),
                  ),
            ),

        ...models.map((model) => {
          const key = providerId + '\u0000' + model.id
          const off = state.models.has(key)
          return h(
            'div',
            {
              key,
              className: 'dsh-settings-resize-model-row',
              'data-disabled': off || providerOff ? 'true' : undefined,
            },
            h(
              'div',
              { className: 'dsh-settings-resize-model-text' },
              h('span', { className: 'dsh-settings-resize-model-name' }, model.name),
              h(
                'span',
                { className: 'dsh-settings-resize-model-note' },
                providerOff
                  ? t('modelRowNoteFollowsProvider')
                  : off
                    ? t('modelRowNoteOff')
                    : t('modelRowNoteOn'),
              ),
            ),
            // No switch while the provider is off: the whole provider is already hidden.
            providerOff
              ? null
              : h(PillSwitch, {
                  on: !off,
                  label: (off ? t('modelEnable') : t('modelDisable')) + ' ' + model.name,
                  disabled: busy !== '',
                  onChange: () =>
                    commit(
                      (current) => {
                        const models = new Set(current.models)
                        if (off) models.delete(key)
                        else models.add(key)
                        return { models, providers: current.providers }
                      },
                      key,
                    ),
                }),
          )
        }),
      )
    }

    /**
     * Reveal everything at once, from a footer link on the Models page.
     *
     * @param props - `t` and the injected model controls.
     */
    function RestoreAllModels(props) {
      const { t, configForms, remote } = props
      const [state, setState] = useState(() => readSwitchState(configForms))
      const [busy, setBusy] = useState(false)
      const useEffect = React.useEffect

      const refresh = useCallback(() => setState(readSwitchState(configForms)), [configForms])
      useEffect(() => {
        const form = configForms.get(RECORD_NS)
        if (form === undefined || form === null) return () => {}
        const dispose = form.subscribe(refresh)
        refresh()
        return () => {
          try {
            dispose()
          } catch {
            // Disposed with its namespace.
          }
        }
      }, [configForms, refresh])

      const total = state.models.size + state.providers.size
      if (total === 0) return null

      return h(
        'div',
        { className: 'dsh-settings-resize-restore-all' },
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: async () => {
              setBusy(true)
              try {
                const empty = { models: new Set(), providers: new Set() }
                await writeSwitchState(configForms, remote, empty)
                setState(empty)
              } finally {
                setBusy(false)
              }
            },
          },
          t('modelRestoreAll', { count: total }),
        ),
      )
    }

    /**
     * Both shipped locales are registered in one call, which the typed form requires:
     * a missing or extra key is a compile error and a half-translated row is impossible.
     */
    const zh = {
      title: '设置窗口尺寸',
      description: '拖动滑块调节设置弹窗的宽高与透明度，改动立刻生效并被记住。',
      width: '宽度',
      height: '高度',
      transparency: '透明度',
      slider: '{label}滑动条',
      field: '{label}（{unit}）',
      unitPx: '像素',
      unitPercent: '百分比',
      current: '当前：{width}px × {height}px · 透明度 {transparency}%',
      reset: '恢复默认',
      noticeInvalid: '请输入数字',
      noticeClamped: '已按范围截断：{min}–{max}{unit}',
      footnote:
        '透明度只让弹窗底衬变透，文字与控件保持清晰；拖到 100% 时底衬完全透明，弹窗边缘仍保留一圈描边，方便定位。窗口较小时宽高会自动缩小，不会超出屏幕。',
      modelSwitchTitle: '在对话中显示',
      modelSwitchHint: '关闭后不再出现在对话的模型选择器中，此处仍可随时打开。',
      modelSwitchHintOff: '已关闭 {count} 个模型',
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

    const en = {
      title: 'Settings window size',
      description: 'Drag the sliders to resize the Settings dialog and adjust its transparency. Changes apply immediately and are remembered.',
      width: 'Width',
      height: 'Height',
      transparency: 'Transparency',
      slider: '{label} slider',
      field: '{label} ({unit})',
      unitPx: 'px',
      unitPercent: '%',
      current: 'Current: {width}px × {height}px · transparency {transparency}%',
      reset: 'Reset to default',
      noticeInvalid: 'Enter a number',
      noticeClamped: 'Clamped to {min}–{max}{unit}',
      footnote:
        'Transparency fades the dialog surface only, so text and controls stay sharp. At 100% the surface is fully clear and a thin outline keeps the dialog edge findable. When the window is small, the size shrinks to fit the screen.',
      modelSwitchTitle: 'Show in conversation',
      modelSwitchHint:
        'When off, it is left out of the conversation model picker. It stays listed here and can be turned back on at any time.',
      modelSwitchHintOff: '{count} model(s) off',
      providerSwitchLabel: '{name} (whole provider)',
      providerSwitchAria: '{action} {name} (whole provider)',
      providerRowNoteOn: "This provider's models are offered in the model picker",
      providerRowNoteOff: 'The whole provider is hidden from the model picker',
      modelRowNoteOn: 'Offered in the model picker',
      modelRowNoteOff: 'Hidden from the model picker',
      modelRowNoteFollowsProvider: 'Hidden with the provider',
      modelEnable: 'On',
      modelDisable: 'Off',
      modelRestoreAll: 'Restore all ({count})',
      modelWriteFailed: 'Write failed: {message}',
    }

    const STYLE_TEXT = `
html {
  --dsh-settings-w: 800px;
  --dsh-settings-h: 800px;
  --dsh-settings-alpha: 100%;
  --dsh-settings-edge: 0%;
}
[data-shortcut-modal="settings"] {
  width: var(--dsh-settings-w) !important;
  height: var(--dsh-settings-h) !important;
  max-width: calc(100vw - 48px) !important;
  max-height: calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))) !important;
  background: color-mix(
    in srgb,
    var(--dsw-alias-bg-layer-2) var(--dsh-settings-alpha, 100%),
    transparent
  ) !important;
  /* Fades in as the surface fades out, so a fully transparent dialog still has an edge.
     An outline takes no space in layout, so the shipped box stays byte-for-byte sized. */
  outline: .5px solid
    color-mix(in srgb, var(--dsw-alias-border-l2) var(--dsh-settings-edge, 0%), transparent) !important;
  outline-offset: -1px !important;
}
.dsh-settings-resize {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.dsh-settings-resize-title {
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.dsh-settings-resize-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-settings-resize-sliders {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-settings-resize-slider {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-settings-resize-slider > .dsh-settings-resize-name {
  flex: none;
  min-width: 68px;
}
.dsh-settings-resize-slider > input[type="range"] {
  flex: 1 1 120px;
  min-width: 0;
  height: 28px;
  margin: 0;
  accent-color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dsh-settings-resize-field {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-settings-resize-field input {
  box-sizing: border-box;
  width: 66px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--dsw-alias-label-primary);
}
.dsh-settings-resize-field input::-webkit-outer-spin-button,
.dsh-settings-resize-field input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.dsh-settings-resize-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.dsh-settings-resize-now {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.dsh-settings-resize-foot button {
  height: 28px;
  padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dsh-settings-resize-foot button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-settings-resize-foot button:disabled {
  opacity: .45;
  cursor: default;
}
.dsh-settings-resize-notice {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-primary);
}
.dsh-settings-resize-rowgroup {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
  padding: 0 0 2px;
}
.dsh-settings-resize-provider-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
}
.dsh-settings-resize-provider-caption {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-settings-resize-rowgroup-label {
  margin-top: 6px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 400;
  color: var(--dsw-alias-label-secondary);
}
.dsh-settings-resize-rowgroup-count {
  margin-left: 6px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-settings-resize-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
  padding: 3px 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dsh-settings-resize-model-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dsh-settings-resize-model-row[data-disabled] .dsh-settings-resize-model-name {
  opacity: .6;
}
.dsh-settings-resize-model-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-settings-resize-model-note {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-settings-resize-restore-all {
  display: flex;
  justify-content: flex-end;
  padding-top: 10px;
}
.dsh-settings-resize-restore-all button {
  height: 28px;
  padding: 0 12px;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dsh-settings-resize-restore-all button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-settings-resize-restore-all button:disabled {
  opacity: .45;
  cursor: default;
}
.dsh-settings-resize-model-badge {
  flex: none;
  padding: 0 6px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-settings-resize-switch {
  flex: none;
  position: relative;
  box-sizing: border-box;
  width: 34px;
  height: 20px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: var(--dsw-alias-border-l4);
  cursor: pointer;
  transition: background .15s ease;
}
.dsh-settings-resize-switch > span {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform .15s ease;
}
.dsh-settings-resize-switch[data-on] {
  background: var(--dsw-alias-brand-primary);
}
.dsh-settings-resize-switch[data-on] > span {
  transform: translateX(14px);
}
.dsh-settings-resize-switch:disabled {
  opacity: .45;
  cursor: default;
}
`

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

    const toNumber = (value) => {
      if (value === null || value === undefined || value === '') return undefined
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }

    /**
     * Coerce anything read from storage into a usable state: whole pixels inside the size
     * domains, a whole percentage inside the transparency domain, tolerating records that
     * stored another shape, another unit, or no transparency at all.
     */
    function normalize(candidate) {
      const raw = candidate !== null && typeof candidate === 'object' ? candidate : {}
      const width = toNumber(raw.width) ?? toNumber(raw.w)
      let height = toNumber(raw.height) ?? toNumber(raw.h)
      // An older record may carry a viewport-relative height; resolve it once, because the
      // custom property is written in pixels only.
      if (raw.heightUnit === 'vh' && height !== undefined) {
        height = (height * (window.innerHeight || DEFAULT_STATE.height)) / 100
      }
      const transparency = toNumber(raw.transparency)
      return {
        width: clamp(Math.round(width === undefined ? DEFAULT_STATE.width : width), WIDTH.min, WIDTH.max),
        height: clamp(Math.round(height === undefined ? DEFAULT_STATE.height : height), HEIGHT.min, HEIGHT.max),
        heightUnit: 'px',
        transparency: clamp(
          Math.round(transparency === undefined ? DEFAULT_STATE.transparency : transparency),
          TRANSPARENCY.min,
          TRANSPARENCY.max,
        ),
      }
    }

    function readStored() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        return normalize(raw === null ? null : JSON.parse(raw))
      } catch {
        return normalize(null)
      }
    }

    /** Push a state onto the document — the custom properties — and remember it. */
    function applyState(state) {
      const next = normalize(state)
      const root = document.documentElement.style
      root.setProperty(VAR_WIDTH, next.width + 'px')
      root.setProperty(VAR_HEIGHT, next.height + 'px')
      // The surface keeps the remainder of its opacity; the slider measures transparency.
      const surface = 100 - next.transparency
      root.setProperty(VAR_ALPHA, surface + '%')
      // The outline takes over as the surface fades, reaching full strength exactly when the
      // surface is gone, so the dialog edge never disappears with it.
      root.setProperty(VAR_EDGE, next.transparency + '%')
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            width: next.width,
            height: next.height,
            heightUnit: next.heightUnit,
            transparency: next.transparency,
          }),
        )
      } catch {
        // A full or blocked storage keeps the state live for this run; it just will not survive a restart.
      }
      return next
    }

    function clearState() {
      const root = document.documentElement.style
      root.removeProperty(VAR_WIDTH)
      root.removeProperty(VAR_HEIGHT)
      root.removeProperty(VAR_ALPHA)
      root.removeProperty(VAR_EDGE)
    }

    /**
     * One labelled slider with a numeric field beside it: the range drags, the field takes an
     * exact value. Both clamp to the domain and report truncation through `onNotice`.
     */
    function Slider(props) {
      const { domain, label, name, value, unitLabel, onCommit, onNotice, t } = props
      const [draft, setDraft] = useState()

      const commitNumber = (raw) => {
        setDraft(raw)
        const trimmed = String(raw).trim()
        if (trimmed === '') {
          onNotice('')
          return
        }
        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed)) {
          onNotice(t('noticeInvalid'))
          return
        }
        const rounded = Math.round(parsed)
        const clamped = clamp(rounded, domain.min, domain.max)
        onNotice(
          clamped === rounded
            ? ''
            : t('noticeClamped', { min: domain.min, max: domain.max, unit: domain.unit }),
        )
        onCommit(clamped)
      }

      return h(
        'div',
        { className: 'dsh-settings-resize-slider' },
        h('span', { className: 'dsh-settings-resize-name' }, label),
        h('input', {
          type: 'range',
          min: domain.min,
          max: domain.max,
          step: domain.step,
          value: value,
          'aria-label': t('slider', { label: label }),
          onChange: (event) => {
            setDraft(undefined)
            onNotice('')
            onCommit(Number(event.target.value))
          },
        }),
        h(
          'label',
          { className: 'dsh-settings-resize-field' },
          h('input', {
            type: 'number',
            inputMode: 'numeric',
            min: domain.min,
            max: domain.max,
            step: domain.step,
            value: draft === undefined ? String(value) : draft,
            'aria-label': t('field', { label: label, unit: unitLabel }),
            onChange: (event) => {
              commitNumber(event.target.value)
            },
            onBlur: () => {
              setDraft(undefined)
            },
          }),
          h('span', { 'aria-hidden': true }, domain.unit),
        ),
      )
    }

    function Section(props) {
      // `t` is supplied by the framework through the registration's `locale` option and
      // re-renders the row when the active language changes.
      const t = props.t
      const [state, setState] = useState(readStored)
      const [notice, setNotice] = useState('')
      // A pointer drag fires several fields in one tick, so the value the next edit composes
      // against comes from a ref rather than from this render's closure.
      const stateRef = useRef(state)

      const commit = useCallback((next) => {
        const applied = applyState(next)
        stateRef.current = applied
        setState(applied)
      }, [])

      const changeWidth = useCallback(
        (width) => {
          commit({ ...stateRef.current, width: width })
        },
        [commit],
      )

      const changeHeight = useCallback(
        (height) => {
          commit({ ...stateRef.current, height: height })
        },
        [commit],
      )

      const changeTransparency = useCallback(
        (transparency) => {
          commit({ ...stateRef.current, transparency: transparency })
        },
        [commit],
      )

      const reset = useCallback(() => {
        setNotice('')
        commit(DEFAULT_STATE)
      }, [commit])

      const isDefault =
        state.width === DEFAULT_STATE.width &&
        state.height === DEFAULT_STATE.height &&
        state.transparency === DEFAULT_STATE.transparency

      return h(
        'div',
        { className: 'dsh-settings-resize' },
        h(
          'div',
          null,
          h('div', { className: 'dsh-settings-resize-title' }, t('title')),
          h('div', { className: 'dsh-settings-resize-desc' }, t('description')),
        ),
        h(
          'div',
          { className: 'dsh-settings-resize-sliders' },
          h(Slider, {
            domain: WIDTH,
            label: t('width'),
            name: 'width',
            unitLabel: t('unitPx'),
            value: state.width,
            onCommit: changeWidth,
            onNotice: setNotice,
            t: t,
          }),
          h(Slider, {
            domain: HEIGHT,
            label: t('height'),
            name: 'height',
            unitLabel: t('unitPx'),
            value: state.height,
            onCommit: changeHeight,
            onNotice: setNotice,
            t: t,
          }),
          h(Slider, {
            domain: TRANSPARENCY,
            label: t('transparency'),
            name: 'transparency',
            unitLabel: t('unitPercent'),
            value: state.transparency,
            onCommit: changeTransparency,
            onNotice: setNotice,
            t: t,
          }),
        ),
        notice === ''
          ? null
          : h('div', { className: 'dsh-settings-resize-notice', role: 'status' }, notice),
        h(
          'div',
          { className: 'dsh-settings-resize-foot' },
          h(
            'span',
            { className: 'dsh-settings-resize-now' },
            t('current', {
              width: state.width,
              height: state.height,
              transparency: state.transparency,
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: isDefault,
              onClick: reset,
            },
            t('reset'),
          ),
        ),
        h('div', { className: 'dsh-settings-resize-desc' }, t('footnote')),
      )
    }

    /**
     * Drop dictionaries an earlier generation of this module registered. The disposer is
     * parked on `globalThis` precisely because an HMR reload resets this module's scope.
     */
    function releaseDictionaries() {
      const host = typeof globalThis !== 'undefined' ? globalThis : undefined
      if (host === undefined) return
      const previous = host[DISPOSER_KEY]
      if (typeof previous !== 'function') return
      delete host[DISPOSER_KEY]
      try {
        previous()
      } catch {
        // A disposer from a torn-down generation may already have run; the claim is what
        // matters, and the register call below re-establishes it.
      }
    }

    /**
     * Take the namespace back from a claim whose disposer is gone.
     *
     * The service exposes no way to drop a namespace, so the only lever is `register`'s own
     * disposer. A claim still owning a language throws on re-registration; reclaiming it
     * means finding that occupant, releasing it, and retrying. When the service offers no
     * such access (the shipped one keeps its maps private) this reports failure and the
     * caller rethrows the original error rather than leaving the row half-translated.
     *
     * @returns whether the namespace is free again.
     */
    function reclaim(locale) {
      // `unregister`/`release` are not part of the shipped API; a future one is honoured if
      // present, otherwise there is nothing to do but report the failure.
      if (typeof locale.unregister === 'function') {
        try {
          locale.unregister(NS)
          return true
        } catch {
          return false
        }
      }
      return false
    }

    function apply(ctx) {
      // The CSS module builds a hashed class for the panel; the data attribute is the only
      // stable handle, so every rule above selects on that.
      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE_TEXT
        document.head.append(style)
        return () => {
          style.remove()
        }
      }, 'dsh-settings-resize: style')

      // Both dictionaries in one call, so the row is never half-translated. Registered before
      // the slot so the first paint already has its text.
      //
      // The locale service keeps one occupant per (namespace, language) and *throws* on a
      // duplicate. A reload can leave an earlier registration behind — an HMR pass re-runs
      // this module, which resets module state, and the previous generation's disposer may
      // not have fired yet. An uncaught throw here would abort the effect and leave the
      // namespace without its `zh` dictionary, so lookups fall through to the `en` fallback
      // and the row can switch to English but never back to Chinese. Release what we own
      // first, then take the namespace over even if a stale claim survives.
      //
      // `locale` is a declared dependency, so it cannot be absent here. Registering outside
      // any "is the service there yet" branch is deliberate: skipping registration silently
      // is exactly what made the row come up in English after a restart.
      const locale = ctx.locale
      ctx.effect(() => {
        // Release whatever an earlier generation of this module left behind, then claim
        // the namespace. Without this, the duplicate claim throws and the `zh` dictionary
        // never lands, so the row switches to English but cannot switch back.
        releaseDictionaries()
        // A stale claim can still outlive its disposer (a page restored from bfcache, or a
        // generation whose global was dropped). Drop the namespace and retry once rather
        // than leaving the row dictionary-less.
        let dispose
        try {
          dispose = locale.register(NS, { zh: zh, en: en })
        } catch (error) {
          if (!reclaim(locale)) throw error
          dispose = locale.register(NS, { zh: zh, en: en })
        }
        const host = typeof globalThis !== 'undefined' ? globalThis : undefined
        if (host !== undefined) host[DISPOSER_KEY] = dispose
        return () => {
          // Only the generation that still owns the claim may release it. A retiring
          // fiber can run its cleanup after the next generation has already re-registered,
          // and releasing unconditionally would delete the fresh dictionaries.
          const owner = host !== undefined && host[DISPOSER_KEY] === dispose
          if (owner) delete host[DISPOSER_KEY]
          if (owner) dispose()
        }
      }, 'dsh-settings-resize: zh/en strings')

      // Apply the remembered state as soon as the plugin starts, and take it back off when
      // the plugin stops, so the shipped dialog returns untouched.
      ctx.effect(
        () => {
          applyState(readStored())
          return () => {
            clearState()
          }
        },
        'dsh-settings-resize: size variables',
      )

      // A row inside General settings. The slot is declared by the General section at
      // runtime, so `inject` accounts for any order between the two registrations.
      // `locale` gives the component a `t` seat and re-renders the row on a language change.
      ctx.effect(
        () =>
          ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              {
                name: 'settings.general.item',
                id: 'settings-resize',
                order: 18,
                locale: NS,
                // Read at projection time, so the nav text follows the active language.
                label: () => locale.bind(NS)('title'),
              },
              Section,
            ),
          ),
        'dsh-settings-resize: general settings row',
      )

      /*
       * Model switches sit inside each provider card on Settings → Models, dispatched by the
       * card's settings namespace, which is what places the row next to Edit / Remove.
       *
       * One registration receives every card of that family, including hand-declared routes,
       * so the switch appears beside each provider's own model list rather than in a panel of
       * its own.
       */
      const configForms = ctx.configForms
      // The settings Remote is what actually persists a switch; without it the block cannot
      // write, so the whole feature is only registered when both faces exist.
      const remote = ctx.remote
      if (configForms !== undefined && remote !== undefined) {
        ctx.effect(
          () =>
            ctx.slots.inject('settings.models.provider-card', () => {
              /*
               * The Models page dispatches `settings.models.provider-card` with each card's
               * `settingsNs` as the key, and for the built-in families that value is the
               * Loader entry id — not a profile-derived name:
               *
               *   llm-deepseek          DeepSeek 账号 (the OAuth route)
               *   llm-deepseek-account  the account-backed route registered by the same package
               *   llm-pi-ai             pi-ai routes (dshcapi and any hand-declared one)
               *
               * Registering all three covers every card the page can show. A key the page
               * never dispatches renders nothing, so an extra one is harmless.
               */
              const disposers = []
              for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']) {
                disposers.push(
                  ctx.slots.register(
                    {
                      name: 'settings.models.provider-card',
                      key: ns,
                      locale: NS,
                      inject: () => ({ configForms, remote }),
                    },
                    ProviderModelSwitches,
                  ),
                )
              }
              return () => {
                for (const dispose of disposers) dispose()
              }
            }),
          'dsh-settings-resize: provider model switches',
        )

        // A footer link reveals everything at once, so a switched-off model can always be
        // brought back even when its provider is not on the page.
        ctx.effect(
          () =>
            ctx.slots.inject('settings.models.footer', () =>
              ctx.slots.register(
                {
                  name: 'settings.models.footer',
                  id: 'settings-resize-restore-models',
                  order: 90,
                  locale: NS,
                  inject: () => ({ configForms, remote }),
                },
                RestoreAllModels,
              ),
            ),
          'dsh-settings-resize: restore all models',
        )
      }
    }

    return {
      name: 'dsh-settings-resize',
      /**
       * `locale` must be a hard dependency, not something `apply` probes with `ctx.get`.
       *
       * A cold page has no ordering guarantee between this plugin and the locale plugin.
       * When this plugin started first, `ctx.get('locale')` returned undefined, the
       * dictionaries were never registered, and the row then rendered through a `t` with no
       * dictionary at all — raw keys on screen, or English once only `en` resolved. Declaring
       * the dependency makes the loader hold this plugin inactive until the service exists,
       * so `apply` always sees a live locale service.
       *
       * `configForms` is the Client face of the shared settings write queue, and
       * `remote.settings` is the RPC face that actually persists a switch.
       *
       * `remote.settings` is a **sub-namespace dependency**: the context only resolves
       * `ctx.remote.settings` when that exact key is declared, so listing the parent `remote`
       * alone throws `cannot get property "remote.settings" without inject` at the first write.
       */
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.settings'],
      apply: apply,
    }
  },
})
