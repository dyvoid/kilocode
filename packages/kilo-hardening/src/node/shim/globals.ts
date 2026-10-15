// Injected by esbuild (see esbuild.cjs): free references to `fetch` and `WebSocket` inside the hardened
// bundle resolve to these exports instead of the extension host's shared globals.
import { wrapFetch } from "../../fetch"
import { permitUrl } from "../../policy"

const guarded = wrapFetch(globalThis.fetch, { scope: "app" })
export { guarded as fetch }

const Real = globalThis.WebSocket
class Guarded extends (Real ?? class {}) {
  constructor(url: string | URL, protocols?: string | string[]) {
    permitUrl("app", String(url), "WebSocket")
    if (!Real) throw new Error("WebSocket is not available in this runtime")
    super(url, protocols)
  }
}
export { Guarded as WebSocket }
