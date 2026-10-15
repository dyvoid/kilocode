import { describe as group, expect, mock, test } from "bun:test"

// The real `vscode` module exists only inside the extension host. VS Code freezes `env`, which is what
// broke the first version of the shim, so the stand-in is frozen the same way.
const opened: string[] = []
const env = Object.freeze({
  appName: "Code",
  openExternal: async (uri: { toString(): string }) => {
    opened.push(uri.toString())
    return true
  },
})
mock.module("vscode", () => Object.freeze({ env, version: "1.100.0" }))

const uri = (text: string) => ({ toString: (skip?: boolean) => (skip ? decodeURIComponent(text) : text) })

group("vscode shim", () => {
  test("works over a frozen env and keeps the other members", async () => {
    const shim = (await import("../src/node/shim/vscode.cjs")) as { default?: unknown } & Record<string, unknown>
    const api = (shim.default ?? shim) as { env: typeof env; version: string }
    expect(api.version).toBe("1.100.0")
    expect(api.env.appName).toBe("Code")
    expect(await api.env.openExternal(uri("http://127.0.0.1:3000/"))).toBe(true)
    expect(await api.env.openExternal(uri("https://kilo.ai/docs"))).toBe(false)
    // The encoded form is what VS Code opens; its decoded form would look like localhost.
    expect(await api.env.openExternal(uri("https://localhost%2F@evil.example/"))).toBe(false)
    expect(opened).toEqual(["http://127.0.0.1:3000/"])
  })
})
