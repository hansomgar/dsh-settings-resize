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
  width: 48px;
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
      const { domain, label, value, hint, onCommit, onNotice } = props
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
          onNotice('请输入数字')
          return
        }
        const rounded = Math.round(parsed)
        const clamped = clamp(rounded, domain.min, domain.max)
        onNotice(clamped === rounded ? '' : `已按范围截断：${domain.min}–${domain.max}${domain.unit}`)
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
          'aria-label': label + '滑动条',
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
            'aria-label': label + (hint === undefined ? '' : '（' + hint + '）'),
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

    function Section() {
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
          h('div', { className: 'dsh-settings-resize-title' }, '设置窗口尺寸'),
          h(
            'div',
            { className: 'dsh-settings-resize-desc' },
            '拖动滑块调节设置弹窗的宽高与透明度，改动立刻生效并被记住。',
          ),
        ),
        h(
          'div',
          { className: 'dsh-settings-resize-sliders' },
          h(Slider, {
            domain: WIDTH,
            label: '宽度',
            hint: '像素',
            value: state.width,
            onCommit: changeWidth,
            onNotice: setNotice,
          }),
          h(Slider, {
            domain: HEIGHT,
            label: '高度',
            hint: '像素',
            value: state.height,
            onCommit: changeHeight,
            onNotice: setNotice,
          }),
          h(Slider, {
            domain: TRANSPARENCY,
            label: '透明度',
            hint: '百分比',
            value: state.transparency,
            onCommit: changeTransparency,
            onNotice: setNotice,
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
            '当前：' +
              state.width +
              'px × ' +
              state.height +
              'px · 透明度 ' +
              state.transparency +
              '%',
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: isDefault,
              onClick: reset,
            },
            '恢复默认',
          ),
        ),
        h(
          'div',
          { className: 'dsh-settings-resize-desc' },
          '透明度只让弹窗底衬变透，文字与控件保持清晰；拖到 100% 时底衬完全透明，弹窗边缘仍保留一圈描边，方便定位。窗口较小时宽高会自动缩小，不会超出屏幕。',
        ),
      )
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
      ctx.effect(
        () =>
          ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              {
                name: 'settings.general.item',
                id: 'settings-resize',
                order: 18,
                label: () => '设置窗口尺寸',
              },
              Section,
            ),
          ),
        'dsh-settings-resize: general settings row',
      )
    }

    return {
      name: 'dsh-settings-resize',
      inject: ['slots'],
      apply: apply,
    }
  },
})
