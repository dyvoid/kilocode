import { afterAll, beforeAll, describe as group, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import raw from "../hardening.config.json"
import { config, entries, parse } from "../src/config"
import { EgressDeniedError, findEgressDenied } from "../src/error"
import { denials } from "../src/log"
import { assertConsistent, permit, permitUrl, validateEndpoint } from "../src/policy"

const dir = mkdtempSync(path.join(os.tmpdir(), "hardening-"))
const log = path.join(dir, "egress.log")

beforeAll(() => {
  process.env.KILO_HARDENING_LOG = log
})

afterAll(() => {
  delete process.env.KILO_HARDENING_LOG
  rmSync(dir, { recursive: true, force: true })
})

function variant(patch: Record<string, unknown>) {
  return parse({ ...structuredClone(raw), ...patch })
}

group("config", () => {
  test("an empty config is valid: defaults everywhere and no preconfigured provider", () => {
    const cfg = parse({})
    expect(cfg.provider).toBeUndefined()
    expect(cfg.identity).toEqual({ publisher: "dyvoid", name: "code-agent", displayName: "Dyvoid Code Agent" })
    expect(cfg.allow).toEqual({ app: [], tools: [] })
    expect(cfg.websearch).toEqual({ providers: [], permission: "ask", audit: false })
    expect([cfg.webfetch, cfg.sandbox]).toEqual(["tools", true])
    expect(() => assertConsistent(cfg)).not.toThrow()
  })

  test("a provider needs only a base URL", () => {
    const cfg = variant({ provider: { baseURL: "http://127.0.0.1:1234/v1", models: { qwen: {} } } })
    expect(cfg.provider).toEqual({ id: "llm", name: "LLM", baseURL: "http://127.0.0.1:1234/v1", models: { qwen: { name: "qwen" } } })
  })

  test("provider values are checked when the config is parsed", () => {
    expect(() => variant({ provider: { baseURL: "llm.corp.example" } })).toThrow("provider.baseURL")
    expect(() => variant({ provider: { baseURL: "ftp://llm.corp.example/" } })).toThrow("provider.baseURL")
    expect(() => variant({ provider: { baseURL: "http://127.0.0.1/v1", models: { m: { limit: {} } } } })).toThrow("limit.context")
    expect(() => variant({ provider: { baseURL: "http://127.0.0.1/v1", models: { m: { limit: { context: 8192, output: "x" } } } } })).toThrow(
      "limit.output",
    )
  })

  test("build notes count tools entries the command sandbox cannot express", async () => {
    const { sandboxNotes } = await import("../src/policy")
    const cfg = variant({
      allow: { tools: [{ host: "git.corp.example" }, { host: "api.corp.example", ports: [443] }, { cidr: "10.0.0.0/8" }, { suffix: "corp.example" }, { host: "10.1.2.3" }] },
    })
    expect(sandboxNotes(cfg)).toEqual([
      "3 allow.tools entries are not reachable from sandboxed commands (IP, CIDR or suffix)",
      "1 allow.tools host without a port list: sandboxed commands use 443 and 80 only",
    ])
    expect(sandboxNotes(variant({}))).toEqual([])
  })

  test("committed default config is valid and self-consistent", () => {
    expect(config.identity.name).toMatch(/^[a-z0-9-]+$/)
    expect(() => assertConsistent()).not.toThrow()
  })

  test("baked config is frozen", () => {
    expect(Object.isFrozen(config)).toBe(true)
  })

  test("search provider hosts join the app scope only", () => {
    const cfg = variant({ websearch: { providers: ["exa"], permission: "ask", audit: false } })
    expect(entries(cfg, "app").some((item) => item.kind === "host" && item.host === "mcp.exa.ai")).toBe(true)
    expect(entries(cfg, "tools")).toHaveLength(0)
  })

  test("rejects unknown search providers and bad identities", () => {
    expect(() => variant({ websearch: { providers: ["google"], permission: "ask", audit: false } })).toThrow(
      "websearch.providers[0]",
    )
    expect(() => variant({ identity: { publisher: "Dyvoid", name: "x", displayName: "X" } })).toThrow(
      "identity.publisher",
    )
  })

  test("a provider outside the allowlist fails the consistency check", () => {
    const cfg = variant({ provider: { baseURL: "https://api.openai.com/v1" } })
    expect(() => assertConsistent(cfg)).toThrow("provider.baseURL")
  })
})

group("permit", () => {
  test("denies with a typed error, logs a JSON line, and keeps the URL path out", () => {
    const err = (() => {
      try {
        permitUrl("app", "https://evil.example/path?key=secret", "test")
      } catch (err) {
        return err
      }
    })()
    expect(err).toBeInstanceOf(EgressDeniedError)
    expect((err as EgressDeniedError).host).toBe("evil.example")
    expect((err as Error).message).not.toContain("secret")
    expect(denials().at(-1)).toMatchObject({ host: "evil.example", scope: "app", via: "test" })
    const line = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!)
    expect(line).toMatchObject({ host: "evil.example", scope: "app", via: "test" })
  })

  test("loopback always passes, other schemes are not network", () => {
    expect(() => permit("tools", "127.0.0.1", 9, "test")).not.toThrow()
    expect(() => permitUrl("tools", "data:text/plain,hi", "test")).not.toThrow()
  })

  test("findEgressDenied walks cause chains", () => {
    const inner = new EgressDeniedError("x.example", "app", "test")
    expect(findEgressDenied(new TypeError("fetch failed", { cause: inner }))).toBe(inner)
    expect(findEgressDenied(new Error("other"))).toBeUndefined()
  })
})

group("validateEndpoint", () => {
  test("explains what is allowed", () => {
    expect(validateEndpoint("http://127.0.0.1:1234/v1")).toBeUndefined()
    expect(validateEndpoint("https://api.openai.com/v1")).toContain("not on this build's allowlist")
    expect(validateEndpoint("ftp://x")).toContain("not a valid http(s) URL")
  })
})
