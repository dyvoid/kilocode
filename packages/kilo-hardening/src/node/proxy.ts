import { randomBytes, timingSafeEqual } from "node:crypto"
import { lookup } from "node:dns/promises"
import http from "node:http"
import net from "node:net"
import type { Duplex } from "node:stream"
import { config, entries, type Config, type Scope } from "../config"
import { record } from "../log"
import { allowsAddress, check, normalize, type Entry } from "../match"

export interface ProxyHandle {
  /** Proxy URLs with credentials, e.g. http://kilo:<token>@127.0.0.1:<port> */
  url: Record<Scope, string>
  close(): Promise<void>
}

export interface ProxyOptions {
  config?: Config
  /** Overrides DNS for tests. */
  resolve?: (host: string) => Promise<string[]>
}

const USER = "kilo"

async function resolveAll(host: string) {
  const found = await lookup(host, { all: true })
  return found.map((item) => item.address)
}

/**
 * Picks the address to dial, or undefined when the destination is not allowed. Names allowed by a
 * host/suffix entry are dialled by name; names that need a CIDR match are resolved here and dialled
 * by the checked address, so the address that was checked is the address that is used.
 */
export async function destination(
  list: readonly Entry[],
  host: string,
  port: number,
  resolve: (host: string) => Promise<string[]> = resolveAll,
) {
  const value = normalize(host)
  const verdict = check(list, value, port)
  if (verdict === "allow") return value
  if (verdict === "deny") return undefined
  const found = await resolve(value).catch(() => [] as string[])
  if (found.length === 0 || !found.every((ip) => allowsAddress(list, ip, port))) return undefined
  return found[0]
}

function authorized(header: string | undefined, token: string) {
  if (!header?.startsWith("Basic ")) return false
  const given = Buffer.from(Buffer.from(header.slice(6), "base64").toString("utf8"))
  const want = Buffer.from(`${USER}:${token}`)
  return given.length === want.length && timingSafeEqual(given, want)
}

function refuse(socket: Duplex, status: string, body = "") {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
}

function blocked(scope: Scope, host: string) {
  return `Blocked by the restricted-egress build: ${host} is not on the ${scope} allowlist.\n`
}

function server(scope: Scope, list: readonly Entry[], token: string, resolve: ProxyOptions["resolve"]) {
  const srv = http.createServer(async (req, res) => {
    // Plain-HTTP forward proxying: the request line carries an absolute URL.
    if (!authorized(req.headers["proxy-authorization"], token)) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="kilo"' }).end()
      return
    }
    const url = URL.canParse(req.url ?? "") ? new URL(req.url!) : undefined
    if (!url || url.protocol !== "http:") {
      res.writeHead(400).end("Only absolute http:// URLs can be proxied without CONNECT.\n")
      return
    }
    const port = Number(url.port || 80)
    const dial = await destination(list, url.hostname, port, resolve)
    if (!dial) {
      record({ scope, host: normalize(url.hostname), via: "proxy" })
      res.writeHead(403, { "Content-Type": "text/plain" }).end(blocked(scope, normalize(url.hostname)))
      return
    }
    const headers = { ...req.headers }
    delete headers["proxy-authorization"]
    delete headers["proxy-connection"]
    const upstream = http.request(
      { host: dial, port, method: req.method, path: `${url.pathname}${url.search}`, headers },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(res)
      },
    )
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" })
      res.end(`Upstream error: ${err.message}\n`)
    })
    req.pipe(upstream)
  })

  srv.on("connect", async (req, socket, head) => {
    socket.on("error", () => socket.destroy())
    if (!authorized(req.headers["proxy-authorization"], token)) {
      refuse(socket, '407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="kilo"')
      return
    }
    const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? "")
    if (!match) {
      refuse(socket, "400 Bad Request")
      return
    }
    const host = normalize(match[1])
    const port = Number(match[2])
    const dial = await destination(list, host, port, resolve)
    if (!dial) {
      record({ scope, host, via: "proxy" })
      refuse(socket, "403 Forbidden", blocked(scope, host))
      return
    }
    const upstream = net.connect({ host: dial, port }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on("error", (err) => refuse(socket, "502 Bad Gateway", `Upstream error: ${err.message}\n`))
    socket.on("close", () => upstream.destroy())
  })
  return srv
}

function listen(srv: http.Server) {
  const ready = Promise.withResolvers<number>()
  srv.once("error", ready.reject)
  srv.listen(0, "127.0.0.1", () => ready.resolve((srv.address() as net.AddressInfo).port))
  return ready.promise
}

/** Starts the app and tools proxies on random loopback ports. */
export async function startProxy(opts: ProxyOptions = {}): Promise<ProxyHandle> {
  const cfg = opts.config ?? config
  const token = randomBytes(24).toString("hex")
  const servers = {
    app: server("app", entries(cfg, "app"), token, opts.resolve),
    tools: server("tools", entries(cfg, "tools"), token, opts.resolve),
  }
  const ports = { app: await listen(servers.app), tools: await listen(servers.tools) }
  const url = (port: number) => `http://${USER}:${token}@127.0.0.1:${port}`
  return {
    url: { app: url(ports.app), tools: url(ports.tools) },
    async close() {
      await Promise.all(
        Object.values(servers).map((srv) => {
          const done = Promise.withResolvers<void>()
          srv.closeAllConnections()
          srv.close(() => done.resolve())
          return done.promise
        }),
      )
    },
  }
}

let shared: Promise<ProxyHandle> | undefined

/** One proxy pair per extension host, started on first use and reused by every CLI spawn. */
export function sharedProxy() {
  shared ??= startProxy().catch((err) => {
    shared = undefined
    throw err
  })
  return shared
}
