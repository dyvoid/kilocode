/**
 * A module object that is the real module except for the given overrides. Writes reach the real module,
 * unlike a `{ ...real }` snapshot.
 */
export function view<T extends object>(real: T, overrides: Record<string, unknown>): T {
  return new Proxy(real, {
    get: (target, key, receiver) => (typeof key === "string" && key in overrides ? overrides[key] : Reflect.get(target, key, receiver)),
    // An assignment (http.globalAgent = agent) reaches the real module, as without the shim, and is
    // what this view returns from then on.
    set: (target, key, value) => {
      if (typeof key === "string" && key in overrides) overrides[key] = value
      return Reflect.set(target, key, value)
    },
  })
}
