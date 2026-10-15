import { describe as group, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { requestTarget, socketTarget } from "../src/guard"

group("guard (child process)", () => {
  test("blocks every client path and allows loopback", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hardening-guard-"))
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture", "guarded.ts")], {
      env: { ...process.env, KILO_HARDENING_LOG: path.join(dir, "egress.log"), KILO_EXPERIMENTAL_EXA: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    rmSync(dir, { recursive: true, force: true })
    expect(err).not.toContain("hardening: could not guard")
    const out = JSON.parse(text.trim().split("\n").at(-1)!)
    expect(out).toEqual({
      "fetch loopback": "ok",
      "fetch blocked": "denied",
      "fetch redirect to blocked": "denied",
      "fetch redirect same host": "ok",
      "fetch manual redirect": "ok",
      WebSocket: "denied",
      "Bun.connect": "denied",
      "net.connect": "denied",
      "net.Socket.connect": "denied",
      "tls.connect": "denied",
      "http.get": "denied",
      "https.request": "denied",
      env: "1",
      experimental: "undefined",
      denials: "9",
    })
  }, 30_000)
})

group("target parsing", () => {
  test("socket forms", () => {
    expect(socketTarget([443, "a.example"])).toEqual({ host: "a.example", port: 443 })
    expect(socketTarget(["443", "a.example"])).toEqual({ host: "a.example", port: 443 })
    expect(socketTarget([{ host: "a.example", port: 1 }])).toEqual({ host: "a.example", port: 1 })
    expect(socketTarget([{ port: 1 }])).toEqual({ host: "localhost", port: 1 })
    expect(socketTarget(["/tmp/sock"])).toBeUndefined()
    expect(socketTarget([{ path: "/tmp/sock" }])).toBeUndefined()
  })

  test("request forms", () => {
    expect(requestTarget(["https://a.example/x"], "https:")?.host).toBe("a.example")
    expect(requestTarget([{ hostname: "a.example", port: 8443 }], "https:")?.host).toBe("a.example:8443")
    expect(requestTarget([{ socketPath: "/tmp/s" }], "http:")).toBeUndefined()
    expect(requestTarget([{ host: "::1" }], "http:")?.hostname).toBe("[::1]")
  })
})
