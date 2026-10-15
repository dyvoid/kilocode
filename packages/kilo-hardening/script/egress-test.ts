#!/usr/bin/env bun
/**
 * Integration test (R7): runs the CLI backend against a local mock OpenAI-compatible server and drives a
 * scripted session, then asserts the build made zero outbound attempts.
 *
 * Three independent detectors:
 *   - the guard's own denial log (KILO_HARDENING_LOG): anything the in-process guard blocked
 *   - a deny-all proxy set as HTTP(S)_PROXY and as the CLI's own proxy: anything that got past the guard
 *     and tried the network the way Bun's fetch, the CLI's children and most tools do
 *   - strace on the CLI and every child it starts: any connect/send to a non-loopback address, and any
 *     DNS query, whether or not it succeeded and whatever library made it
 * In CI this runs in a network namespace with only loopback, so nothing can actually leave; the detectors
 * are what turn an attempt into a failure. Without strace on PATH the third detector is skipped, unless
 * EGRESS_REQUIRE_STRACE=1 (set in CI), which makes its absence a failure.
 *
 * Usage: bun script/egress-test.ts [--keep]
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const root = path.join(import.meta.dir, "..", "..", "..")
const dir = mkdtempSync(path.join(os.tmpdir(), "egress-test-"))
const home = path.join(dir, "home")
const work = path.join(dir, "work")
const denied = path.join(dir, "egress-denied.log")
const attempts = path.join(dir, "proxy.log")
const syscalls = path.join(dir, "strace.log")
const strace = process.env.EGRESS_STRACE === "0" ? null : Bun.which("strace")
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, "README.md"), "# egress test\n")
writeFileSync(attempts, "")

// Deny-all proxy: logs every CONNECT / absolute-URI request and refuses it.
const proxy = net.createServer((socket) => {
  socket.once("data", (data) => {
    const line = data.toString("latin1").split("\r\n")[0] ?? ""
    appendFileSync(attempts, `${line}\n`)
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  })
  socket.on("error", () => socket.destroy())
})
await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", () => done()))
const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`

// Mock OpenAI-compatible provider: first turn calls the bash tool, later turns answer with text.
let calls = 0
function sse(chunks: unknown[]) {
  const body = chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
function chunk(delta: unknown, finish: string | null = null) {
  return { id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] }
}
const llm = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "mock", object: "model" }] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    calls++
    const body = (await req.json()) as { messages: { role: string }[] }
    const first = !body.messages.some((item) => item.role === "tool") && !JSON.stringify(body.messages).includes("title")
    if (first)
      return sse([
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "bash", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "echo hello", description: "Print hello" }) } }] }),
        chunk({}, "tool_calls"),
      ])
    return sse([chunk({ role: "assistant", content: "done" }), chunk({}, "stop")])
  },
})

const config = path.join(dir, "config.json")
writeFileSync(
  config,
  JSON.stringify({
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: `http://127.0.0.1:${llm.port}/v1`, apiKey: "x" },
        models: { mock: { name: "Mock" } },
      },
    },
    model: "mock/mock",
    small_model: "mock/mock",
  }),
)

const cli = ["bun", "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts", "serve", "--port", "0", "--hostname", "127.0.0.1"]
const trace = strace ? [strace, "-f", "-qq", "--kill-on-exit", "-e", "trace=connect,sendto,sendmsg", "-o", syscalls] : []
const serve = Bun.spawn(
  [...trace, ...cli],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      NO_PROXY: "127.0.0.1,localhost,::1",
      KILO_HARDENING_CLI_PROXY: proxyUrl,
      KILO_HARDENING_LOG: denied,
      KILO_CONFIG: config,
      // What the extension sets, including the variables hardening must override.
      KILO_CLIENT: "vscode",
      KILO_PLATFORM: "vscode",
      KILO_TELEMETRY_LEVEL: "all",
      KILO_EXPERIMENTAL: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
)

const started = Date.now()
const step = (name: string) => console.error(`[egress ${((Date.now() - started) / 1000).toFixed(1)}s] ${name}`)
const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}
check(!!strace || process.env.EGRESS_REQUIRE_STRACE !== "1", "strace is required (EGRESS_REQUIRE_STRACE=1) but not on PATH")

/** strace lines for IP connects/sends that leave loopback, or that go to port 53 (DNS) anywhere. */
function outbound(text: string) {
  return text.split("\n").filter((line) => {
    const port = /sin6?_port=htons\((\d+)\)/.exec(line)?.[1]
    if (!port) return false
    const addr = /inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)"/.exec(line)
    const ip = addr?.[1] ?? addr?.[2] ?? ""
    const loop = ip.startsWith("127.") || ip === "::1" || ip.startsWith("::ffff:127.")
    return port === "53" || !loop
  })
}

try {
  const port = await (async () => {
    const reader = serve.stdout.getReader()
    const text = { value: "" }
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const part = await reader.read()
      if (part.done) break
      text.value += new TextDecoder().decode(part.value)
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(text.value)
      if (match) {
        reader.releaseLock()
        return Number(match[1])
      }
    }
    throw new Error(`CLI did not start:\n${text.value}\n${await new Response(serve.stderr).text()}`)
  })()
  step("CLI listening")
  const base = `http://127.0.0.1:${port}`
  const query = `directory=${encodeURIComponent(work)}`
  const headers = { "content-type": "application/json", "x-kilo-directory": work }

  // Every parameterless GET route: stands in for the extension loading its views and settings pages,
  // including the marketplace, profile and cloud entry points.
  const doc = (await (await fetch(`${base}/doc`)).json()) as { paths: Record<string, { get?: unknown }> }
  const routes = Object.entries(doc.paths)
    .filter(([route, item]) => item.get && !route.includes("{") && !/event|pty|tui\/control\/next|\*/.test(route))
    .map(([route]) => route)
  for (const route of routes) await fetch(`${base}${route}?${query}`, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => undefined)
  for (const route of ["/kilocode/marketplace", "/kilo/profile", "/kilo/cloud-sessions", "/remote/status"]) {
    const res = await fetch(`${base}${route}?${query}`, { headers })
    // The gate's own body, so a route that simply does not exist does not count as refused.
    const body = await res.text()
    check(res.status === 404 && body.includes("not available in this build"), `${route} should be refused, got ${res.status} ${body.slice(0, 200)}`)
  }

  step(`visited ${routes.length} routes`)
  // What the extension does on connect when VS Code telemetry is on.
  await fetch(`${base}/telemetry/setEnabled?${query}`, { method: "POST", headers, body: JSON.stringify({ enabled: true }) })

  const providers = (await (await fetch(`${base}/provider?${query}`, { headers })).json()) as { all: { id: string }[] }
  const ids = providers.all.map((item) => item.id).sort()
  check(!ids.includes("kilo") && !ids.includes("openai") && !ids.includes("anthropic"), `unexpected providers: ${ids.join(", ")}`)

  step("starting session")
  const session = (await (await fetch(`${base}/session?${query}`, { method: "POST", headers, body: "{}" })).json()) as { id: string }
  await fetch(`${base}/session/${session.id}/message?${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ providerID: "mock", modelID: "mock", parts: [{ type: "text", text: "run echo hello" }] }),
    signal: AbortSignal.timeout(120_000),
  })
  step("session turn finished")
  const messages = (await (await fetch(`${base}/session/${session.id}/message?${query}`, { headers })).json()) as {
    parts: { type: string; tool?: string; state?: { status: string; output?: string } }[]
  }[]
  const tool = messages.flatMap((item) => item.parts).find((part) => part.type === "tool")
  check(tool?.state?.status === "completed" && tool.state.output?.includes("hello") === true, `bash tool did not complete: ${JSON.stringify(tool?.state)}`)
  check(calls >= 2, `mock provider saw ${calls} calls`)

  step("idle window")
  // Idle window: background timers (catalog refresh, telemetry flush, pollers) get a chance to fire.
  await Bun.sleep(Number(process.env.EGRESS_IDLE_MS ?? 15_000))
} catch (err) {
  failures.push(String(err))
} finally {
  // Always evaluated, even when a step above threw.
  const blocked = readFileSync(denied, { encoding: "utf8", flag: "a+" }).trim()
  check(blocked === "", `guard denied outbound attempts:\n${blocked}`)
  const tried = readFileSync(attempts, "utf8").trim()
  check(tried === "", `outbound attempts reached the proxy:\n${tried}`)
  step("stopping CLI")
  // Under strace, signal the traced CLI itself: strace keeps running until its tracee exits.
  const list = `/proc/${serve.pid}/task/${serve.pid}/children`
  const children = strace && existsSync(list) ? readFileSync(list, "utf8").split(/\s+/).filter(Boolean) : []
  for (const pid of children) process.kill(Number(pid), "SIGTERM")
  if (children.length === 0) serve.kill()
  const stopped = await Promise.race([serve.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
  if (!stopped) serve.kill("SIGKILL")
  await serve.exited
  step("CLI stopped")
  if (strace) {
    const lines = outbound(readFileSync(syscalls, { encoding: "utf8", flag: "a+" }))
    check(lines.length === 0, `outbound connections or DNS queries (strace):\n${lines.slice(0, 50).join("\n")}`)
  }
  llm.stop(true)
  proxy.close()
  if (!process.argv.includes("--keep")) rmSync(dir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`egress test FAILED\n- ${failures.join("\n- ")}`)
  process.exit(1)
}
console.log(`egress test passed: zero outbound attempts${strace ? " (guard, proxy, strace)" : " (guard, proxy; strace not found)"}, session completed against the local provider`)
process.exit(0)
