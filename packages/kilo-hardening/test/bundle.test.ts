import { describe as group, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

// The extension's toolchain: esbuild and ws come from packages/kilo-vscode, as in the real build.
const vscode = createRequire(path.join(import.meta.dir, "..", "..", "kilo-vscode", "package.json"))
// esbuild is a dependency of the extension, not of this package: keep its types local.
const esbuild = vscode("esbuild") as { build(opts: Record<string, unknown>): Promise<unknown> }
const hardening = vscode(path.join(import.meta.dir, "..", "esbuild.cjs")) as { plugin: unknown; inject: string[] }

group("extension bundle (Node)", () => {
  test("guards the bundle's own network clients and leaves globals alone", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hardening-bundle-"))
    const outfile = path.join(dir, "out.mjs")
    await esbuild.build({
      entryPoints: [path.join(import.meta.dir, "fixture", "bundled.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      nodePaths: [path.join(import.meta.dir, "..", "..", "kilo-vscode", "node_modules")],
      plugins: [hardening.plugin],
      inject: hardening.inject,
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      logLevel: "silent",
    })
    const proc = Bun.spawn(["node", "--input-type=module", "-e", `await import(${JSON.stringify(outfile)})`], {
      env: { ...process.env, KILO_HARDENING_LOG: path.join(dir, "egress.log") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    rmSync(dir, { recursive: true, force: true })
    const line = text.trim().split("\n").at(-1)
    if (!line) throw new Error(err)
    expect(JSON.parse(line)).toEqual({
      "fetch loopback": "ok",
      "fetch blocked": "denied",
      WebSocket: "denied",
      "ws package": "denied",
      "net.connect": "denied",
      "net.Socket": "denied",
      "tls.connect": "denied",
      "http.get": "denied",
      "https.request": "denied",
      global: "untouched",
    })
  }, 60_000)
})
