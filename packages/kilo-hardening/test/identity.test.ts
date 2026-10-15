import { describe as group, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import raw from "../hardening.config.json"
import { parse } from "../src/config"
import { apply, manifest, rename, restore } from "../script/identity"

const cfg = parse(raw)
const upstream = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "kilo-vscode", "package.json"), "utf8"))

group("identity", () => {
  test("renames every upstream identifier form", () => {
    expect(rename(`getExtension("kilocode.kilo-code")`, cfg)).toBe(`getExtension("dyvoid.code-agent")`)
    expect(rename(`"kilo-code.new.settingsButtonClicked"`, cfg)).toBe(`"code-agent.new.settingsButtonClicked"`)
    expect(rename("`kilo-code.new.${key}`", cfg)).toBe("`code-agent.new.${key}`")
    expect(rename(`"kilo-code-ActivityBar"`, cfg)).toBe(`"code-agent-ActivityBar"`)
    expect(rename(String.raw`/^kilo-code\.new\.(\w+)Panel$/`, cfg)).toBe(String.raw`/^code-agent\.new\.(\w+)Panel$/`)
    // Not identifiers: the app name, bot logins and npm scopes stay.
    expect(rename(`KILO_APP_NAME: "kilo-code"`, cfg)).toBe(`KILO_APP_NAME: "kilo-code"`)
    expect(rename(`"kilo-code-bot"`, cfg)).toBe(`"kilo-code-bot"`)
    expect(rename(`"@kilocode/kilo-code.x"`, cfg)).toBe(`"@kilocode/kilo-code.x"`)
  })

  test("the real manifest gets the new identity, no upstream namespace and no removed commands", () => {
    const out = manifest(upstream, cfg)
    expect([out.publisher, out.name, out.displayName]).toEqual(["dyvoid", "code-agent", "Dyvoid Code Agent"])
    const text = JSON.stringify(out)
    expect(text).not.toMatch(/"kilo-code\./)
    expect(text).not.toContain("kilocode.kilo-code")
    expect(text).not.toContain("marketplaceButtonClicked")
    expect(text).not.toContain("profileButtonClicked")
    expect(text).not.toContain("autocomplete.generateSuggestions")
    expect(out.contributes?.commands?.some((item) => item.command === "code-agent.new.settingsButtonClicked")).toBe(true)
    // Nothing the manifest still references was dropped from its command list.
    const commands = new Set(out.contributes?.commands?.map((item) => item.command))
    for (const list of Object.values(out.contributes?.menus ?? {}))
      for (const item of list) if (item.command?.startsWith("code-agent.")) expect(commands.has(item.command)).toBe(true)
  })

  test("apply rewrites tracked files and dist, restore puts tracked files back", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "identity-"))
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(upstream))
    writeFileSync(path.join(dir, "package.nls.json"), `{"x":"kilo-code.new.a"}`)
    mkdirSync(path.join(dir, "dist"))
    writeFileSync(path.join(dir, "dist", "extension.js"), `registerCommand("kilo-code.new.a")`)
    apply(dir, cfg)
    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("code-agent")
    expect(readFileSync(path.join(dir, "package.nls.json"), "utf8")).toBe(`{"x":"code-agent.new.a"}`)
    expect(readFileSync(path.join(dir, "dist", "extension.js"), "utf8")).toBe(`registerCommand("code-agent.new.a")`)
    apply(dir, cfg) // idempotent: always derived from the saved upstream copy
    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("code-agent")
    restore(dir)
    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("kilo-code")
    expect(readFileSync(path.join(dir, "package.nls.json"), "utf8")).toBe(`{"x":"kilo-code.new.a"}`)
    rmSync(dir, { recursive: true, force: true })
  })
})
