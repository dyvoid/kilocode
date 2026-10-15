// Bundle-scoped view of the `vscode` API (see ../../../esbuild.cjs): identical to the real module except
// that env.openExternal refuses links that ../links.ts does not allow. The real module is external,
// provided by the extension host at runtime.
const real = require("vscode")
const links = require("../links")

async function openExternal(target) {
  const text = target.toString(true)
  if (links.allowed(text)) return real.env.openExternal(target)
  links.refused(text)
  return false
}

const env = new Proxy(real.env, {
  get: (target, key, receiver) => (key === "openExternal" ? openExternal : Reflect.get(target, key, receiver)),
})

module.exports = new Proxy(real, {
  get: (target, key, receiver) => (key === "env" ? env : Reflect.get(target, key, receiver)),
})
