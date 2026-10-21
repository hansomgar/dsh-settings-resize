/**
 * Host half of dsh-settings-resize.
 *
 * The whole feature lives in the browser: the Client half writes the two CSS custom
 * properties that size the Settings modal and keeps them in `localStorage`. This row
 * exists so the package is a Loader entry at all, which is what makes the Web GUI
 * publish `./client` into the boot graph.
 */
export const name = 'dsh-settings-resize'

export function apply() {}
