// Bundle-scoped view of the `vscode` API (see ../../../esbuild.cjs): identical to the real module except
// that env.openExternal refuses links that ../links.ts does not allow. The real module is external,
// provided by the extension host at runtime.
const real = require("vscode")
const links = require("../links")

async function openExternal(target) {
  // Check the string VS Code will open (encoded), not the display form, which can parse to another host.
  const text = target.toString()
  if (links.allowed(text)) return real.env.openExternal(target)
  links.refused(text)
  return false
}

// VS Code freezes `env` (and may freeze other API objects). A proxy over a frozen object must return the
// real value for its read-only properties, so these views proxy an empty object and forward to the real one.
function view(source, overrides) {
  return new Proxy(
    {},
    {
      get: (_, key) => (key in overrides ? overrides[key] : Reflect.get(source, key)),
      has: (_, key) => key in overrides || Reflect.has(source, key),
      ownKeys: () => [...new Set([...Reflect.ownKeys(source), ...Object.keys(overrides)])],
      getOwnPropertyDescriptor: (_, key) => {
        if (key in overrides) return { value: overrides[key], enumerable: true, configurable: true, writable: false }
        const found = Reflect.getOwnPropertyDescriptor(source, key)
        return found && { ...found, configurable: true }
      },
      set: (_, key, value) => Reflect.set(source, key, value),
    },
  )
}

const env = view(real.env, { openExternal })

module.exports = view(real, { env })
