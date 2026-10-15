// Browser-safe UI switches for the webview bundles. `__KILO_HARDENED__` is defined as `true` by the
// extension's esbuild config (see ../esbuild.cjs); unit tests and stories run without it and see the
// upstream UI.
import { config } from "./config"

declare const __KILO_HARDENED__: boolean | undefined

export const hardened = typeof __KILO_HARDENED__ !== "undefined" && __KILO_HARDENED__ === true

/** True when a feature the restricted build can hide is shown. */
export function shown(name: keyof typeof config.features) {
  return !hardened || config.features[name]
}
