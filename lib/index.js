/**
 * Host half of dsh-settings-resize.
 *
 * Intentionally empty. Both features are browser-side:
 *
 * - the Settings dialog resize needs only CSS custom properties;
 * - model enable/disable writes the settings document through the Client's
 *   `ctx.configForms` face, which is the same write queue the Models page uses.
 *
 * This row exists so the package is a Loader entry at all, which is what makes the Web
 * GUI publish `./client` into the boot graph.
 *
 * @remarks
 * A `host.call` bridge was considered and rejected: that bridge belongs to cordis dynamic
 * packages (`harness.handle`), and a bundle's client factory receives only `require`, so
 * it has no `host` object. Reaching the settings document from the Client is the supported
 * path, and it also gives revision-checked writes for free.
 */
export const name = 'dsh-settings-resize'

export function apply() {}