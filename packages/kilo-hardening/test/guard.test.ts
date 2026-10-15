import { describe as group, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { requestTarget, socketTarget } from "../src/guard"

group("guard (child process)", () => {
  test("blocks every client path and allows loopback", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hardening-guard-"))
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture", "guarded.ts")], {
      env: {
        ...process.env,
        KILO_HARDENING_LOG: path.join(dir, "egress.log"),
        KILO_EXPERIMENTAL_EXA: "1",
        HTTPS_PROXY: "http://proxy.blocked.invalid:3128",
        KILO_HARDENING_CLI_PROXY: "http://proxy.blocked.invalid:3128",
      },
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
      "fetch redirect flag": "ok",
      "fetch redirect to file": expect.stringContaining("redirect to a non-HTTP(S) URL"),
      "fetch 307 replays a Request body": "ok",
      "fetch s3 scheme": "denied",
      "fetch caller proxy": "denied",
      "fetch data with a stray env proxy": "ok",
      "Bun.file s3": "denied",
      "WebSocket proxy option": "denied",
      "fetch.preconnect": "denied",
      WebSocket: "denied",
      "Bun.connect": "denied",
      "Bun.connect host": "denied",
      "Bun.udpSocket": "denied",
      "Bun.sql": "denied",
      "Bun.s3": "denied",
      "net.connect": "denied",
      "net.Socket.connect": "denied",
      "tls.connect": "denied",
      "http.get": "denied",
      "https.request": "denied",
      "http.request url + options": "denied",
      "http.ClientRequest": "denied",
      "dgram.send": "denied",
      "dgram.connect": "denied",
      "http.ClientRequest.call": "denied",
      "dgram connected loopback": "ok",
      "named net.connect": "denied",
      "named net.createConnection": "denied",
      "named tls.connect": "denied",
      "checked marker": "ok",
      "stray proxy": "undefined",
      "cli proxy": "undefined",
      env: "1",
      experimental: "undefined",
      denials: "26",
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
    expect(requestTarget(["https://a.example/x"], "https:")).toEqual({ host: "a.example", port: 443 })
    expect(requestTarget([{ hostname: "a.example", port: 8443 }], "https:")).toEqual({ host: "a.example", port: 8443 })
    expect(requestTarget([{ socketPath: "/tmp/s" }], "http:")).toBeUndefined()
    expect(requestTarget([{ host: "::1" }], "http:")).toEqual({ host: "::1", port: 80 })
    expect(requestTarget(["http://[::1]:8080/"], "http:")).toEqual({ host: "::1", port: 8080 })
    // Node merges (url, options) with options winning, and prefers hostname over host.
    expect(requestTarget(["http://127.0.0.1:1/", { hostname: "blocked.invalid" }], "http:")).toEqual({ host: "blocked.invalid", port: 1 })
    expect(requestTarget(["http://127.0.0.1/", () => {}], "http:")).toEqual({ host: "127.0.0.1", port: 80 })
    expect(requestTarget([{ host: "a.example", protocol: "https:" }], "http:")).toEqual({ host: "a.example", port: 443 })
    // Characters a URL parser would cut at are kept, so the name never matches an allowed one.
    expect(requestTarget([{ hostname: "localhost\\x.evil.invalid" }], "http:")?.host).toBe("localhost\\x.evil.invalid")
  })
})
