import { describe, expect, test } from "bun:test"
import { config as baked, parse } from "@kilocode/kilo-hardening"
import { apply, PROVIDER_NPM, type Shape } from "../../../src/kilocode/hardening/config"

const build = parse({
  ...structuredClone(baked),
  provider: { id: "llm", name: "Corp LLM", baseURL: "https://llm.corp.example/v1", models: { big: { name: "Big" } } },
  allow: { app: [{ host: "llm.corp.example" }], tools: [{ host: "llm.corp.example" }, { host: "git.corp.example" }] },
  sandbox: true,
})

function run(cfg: Shape) {
  const warnings: { path: string; message: string; detail?: string }[] = []
  return { cfg: apply(cfg, warnings, build), warnings }
}

describe("hardening config layer", () => {
  test("a fresh install gets the build's provider and default model", () => {
    const { cfg, warnings } = run({})
    expect(cfg.enabled_providers).toEqual(["llm"])
    expect(cfg.provider?.llm).toMatchObject({
      npm: PROVIDER_NPM,
      name: "Corp LLM",
      options: { baseURL: "https://llm.corp.example/v1" },
      models: { big: { name: "Big" } },
    })
    expect(cfg.model).toBe("llm/big")
    expect(cfg.small_model).toBe("llm/big")
    expect(warnings).toEqual([])
  })

  test("users can add models to the build's provider", () => {
    const { cfg } = run({ provider: { llm: { models: { small: { name: "Small" } } } }, model: "llm/small" })
    expect(Object.keys(cfg.provider?.llm?.models ?? {})).toEqual(["big", "small"])
    expect(cfg.model).toBe("llm/small")
  })

  test("non OpenAI-compatible and off-allowlist providers are disabled with a warning", () => {
    const { cfg, warnings } = run({
      provider: {
        openai: { npm: "@ai-sdk/openai", options: { apiKey: "x" } },
        rogue: { npm: PROVIDER_NPM, options: { baseURL: "https://api.example.com/v1" } },
        local: { npm: PROVIDER_NPM, options: { baseURL: "http://127.0.0.1:1234/v1" } },
      },
      model: "openai/gpt",
    })
    expect(cfg.enabled_providers).toEqual(["llm", "local"])
    expect(cfg.model).toBe("llm/big")
    expect(warnings.map((item) => item.path)).toEqual(["provider.openai", "provider.rogue.options.baseURL"])
    expect(warnings[1].detail).toContain("not on this build's allowlist")
  })

  test("a user base URL outside the allowlist disables even the build's provider", () => {
    const { cfg, warnings } = run({ provider: { llm: { options: { baseURL: "https://elsewhere.example/v1" } } } })
    expect(cfg.enabled_providers).toEqual([])
    expect(cfg.model).toBeNull()
    expect(warnings[0].path).toBe("provider.llm.options.baseURL")
  })

  test("npm plugins, remote MCP, remote instructions and skills outside the allowlist are dropped", () => {
    const { cfg, warnings } = run({
      plugin: ["some-npm-plugin", "file:///home/me/plugin.ts"],
      mcp: {
        far: { type: "remote", url: "https://mcp.example.com/sse" },
        near: { type: "remote", url: "https://git.corp.example/mcp" },
        local: { type: "local", command: ["x"] },
      },
      instructions: ["https://wiki.example.com/rules.md", "AGENTS.md"],
      skills: { urls: ["https://skills.example.com/"] },
    })
    expect(cfg.plugin).toEqual(["file:///home/me/plugin.ts"])
    expect(cfg.mcp?.far).toMatchObject({ enabled: false })
    expect(cfg.mcp?.near).not.toHaveProperty("enabled")
    expect(cfg.instructions).toEqual(["AGENTS.md"])
    expect(cfg.skills?.urls).toEqual([])
    expect(warnings.map((item) => item.path)).toEqual(["plugin", "mcp.far.url", "instructions", "skills.urls"])
  })

  test("share and autoupdate are off and agent commands are sandboxed to the tools scope", () => {
    const { cfg } = run({ share: "auto", autoupdate: true })
    expect(cfg.share).toBe("disabled")
    expect(cfg.autoupdate).toBe(false)
    expect(cfg.sandbox).toEqual({ enabled: true, network: "deny", allowed_hosts: ["llm.corp.example", "git.corp.example"] })
  })
})
