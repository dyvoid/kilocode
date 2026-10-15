// esbuild integration for the VS Code extension bundle.
//
// The extension host is shared with every other installed extension, so the hardened build must not
// patch Node's modules or globals process-wide. Instead, imports of net/tls/http/https inside our own
// bundle (including bundled dependencies such as `ws`) resolve to guarded shims, and free references
// to `fetch` / `WebSocket` are rewritten to guarded versions via esbuild's `inject`.
const path = require("node:path")

const src = path.join(__dirname, "src")
const shims = path.join(src, "node", "shim")
const modules = new Set(["net", "tls", "http", "https"])

const plugin = {
  name: "kilo-hardening",
  setup(build) {
    build.onResolve({ filter: /^(node:)?(net|tls|http|https)$/ }, (args) => {
      // The shims and the guard itself need the real modules.
      if (args.importer.startsWith(src + path.sep)) return undefined
      const name = args.path.replace(/^node:/, "")
      if (!modules.has(name)) return undefined
      return { path: path.join(shims, `${name}.ts`) }
    })
  },
}

module.exports = {
  plugin,
  inject: [path.join(shims, "globals.ts")],
  activate: path.join(src, "node", "activate.ts"),
}
