import { afterAll, beforeAll, describe as group, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import raw from "../hardening.config.json"
import { parse } from "../src/config"
import { denials } from "../src/log"
import { entry } from "../src/match"
import { destination, startProxy, type ProxyHandle } from "../src/node/proxy"
import { buildSpawnEnv } from "../src/node/spawn"

const dir = mkdtempSync(path.join(os.tmpdir(), "hardening-proxy-"))
let proxy: ProxyHandle
let echo: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  process.env.KILO_HARDENING_LOG = path.join(dir, "egress.log")
  proxy = await startProxy({ config: parse(raw) })
  echo = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(`echo ${new URL(req.url).pathname}`) })
})

afterAll(async () => {
  await proxy.close()
  echo.stop(true)
  delete process.env.KILO_HARDENING_LOG
  rmSync(dir, { recursive: true, force: true })
})

function parts(url: string) {
  const parsed = new URL(url)
  return { port: Number(parsed.port), auth: Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64") }
}

async function connect(url: string, target: string, auth = true) {
  const p = parts(url)
  const socket = net.connect(p.port, "127.0.0.1")
  const reply = Promise.withResolvers<string>()
  socket.on("data", (data) => reply.resolve(data.toString()))
  socket.on("error", reply.reject)
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${p.auth}\r\n` : ""}\r\n`)
  const text = await reply.promise
  socket.destroy()
  return text.split("\r\n")[0]
}

group("proxy", () => {
  test("requires its credentials", async () => {
    expect(await connect(proxy.url.tools, `127.0.0.1:${echo.port}`, false)).toContain("407")
  })

  test("tunnels to loopback and refuses hosts off the allowlist", async () => {
    expect(await connect(proxy.url.tools, `127.0.0.1:${echo.port}`)).toContain("200")
    expect(await connect(proxy.url.app, "blocked.invalid:443")).toContain("403")
    expect(denials().at(-1)).toMatchObject({ host: "blocked.invalid", scope: "app", via: "proxy" })
  })

  test("forwards plain http by absolute URL", async () => {
    const res = await fetch(`http://127.0.0.1:${echo.port}/hello`, { proxy: proxy.url.tools } as RequestInit)
    expect(await res.text()).toBe("echo /hello")
  })

  test("Bun fetch sends the proxy credentials and gets a denial, not a 407", async () => {
    const before = denials().length
    // Bun surfaces a refused CONNECT as the proxy's own response.
    const res = await fetch("https://blocked-by-proxy.invalid/", { proxy: proxy.url.app } as RequestInit)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain("not on the app allowlist")
    expect(denials().length).toBe(before + 1)
    expect(denials().at(-1)?.host).toBe("blocked-by-proxy.invalid")
  })

  test("spawn env points children at the tools proxy and keeps loopback direct", () => {
    const env = buildSpawnEnv(proxy)
    expect(env.HTTPS_PROXY).toBe(proxy.url.tools)
    expect(env.KILO_HARDENING_APP_PROXY).toBe(proxy.url.app)
    expect(env.NO_PROXY).toContain("127.0.0.1")
  })
})

group("destination", () => {
  const list = [entry({ host: "llm.corp.example" }), entry({ cidr: "10.9.0.0/16" })]
  const resolve = (map: Record<string, string[]>) => async (host: string) => map[host] ?? []

  test("named hosts are dialled by name", async () => {
    expect(await destination(list, "LLM.corp.example", 443)).toBe("llm.corp.example")
  })

  test("cidr names are dialled by the checked address", async () => {
    expect(await destination(list, "gpu.lan", 80, resolve({ "gpu.lan": ["10.9.0.5"] }))).toBe("10.9.0.5")
  })

  test("a name with any address outside the range is refused", async () => {
    expect(await destination(list, "gpu.lan", 80, resolve({ "gpu.lan": ["10.9.0.5", "8.8.8.8"] }))).toBeUndefined()
    expect(await destination(list, "gone.lan", 80, resolve({}))).toBeUndefined()
  })
})
