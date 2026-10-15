import dgram from "node:dgram"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import type { Scope } from "./config"
import { EgressDeniedError } from "./error"
import { wrapFetch } from "./fetch"
import { record } from "./log"
import { permit, permitUrl } from "./policy"

export interface GuardOptions {
  scope: Scope
  /** Allowlist proxy for this process's own fetch traffic (see wrapFetch). */
  proxy?: string
  /** A proxy from the environment that is not allowed (see wrapFetch). */
  stray?: string
}

const key = Symbol.for("kilo.hardening.guard")
type Holder = { [key]?: GuardOptions }

/**
 * Options key for callers that resolved and vetted a name themselves and dial the address (the command
 * sandbox's proxy): the guard checks this name instead of the address.
 */
export const CHECKED = Symbol.for("kilo.hardening.checked")

type Target = {
  host?: string | null
  hostname?: string | null
  port?: number | string | null
  path?: string | null
  [CHECKED]?: string
}
type Options = Target & { protocol?: string | null; socketPath?: string | null; defaultPort?: number | string | null }

/** Extracts host and port from the overloaded (options | port, host | path) forms of net/tls connect. */
export function socketTarget(args: unknown[]): { host: string; port?: number } | undefined {
  const [first, second] = args
  // Bun's net.connect/tls.connect call socket.connect([options, listener]) with pre-normalised arguments.
  if (Array.isArray(first)) return socketTarget(first)
  if (typeof first === "string" && !/^\d+$/.test(first)) return undefined // unix socket / named pipe path
  if (typeof first === "number" || typeof first === "string")
    return { host: typeof second === "string" ? second : "localhost", port: Number(first) }
  if (first && typeof first === "object") {
    const opts = first as Target
    if (opts.path) return undefined
    const host = opts[CHECKED] ?? String(opts.host || opts.hostname || "localhost")
    return { host, port: opts.port == null ? undefined : Number(opts.port) }
  }
  return undefined
}

/**
 * Destination of http(s).request/get and `new ClientRequest`, in their (url | options, [options]) forms,
 * resolved the way Node does: options override the URL, `hostname` wins over `host`.
 */
export function requestTarget(args: unknown[], protocol: "http:" | "https:"): { host: string; port: number } | undefined {
  const [first, second] = args
  const url = typeof first === "string" || first instanceof URL ? new URL(String(first)) : undefined
  const extra = url ? second : first
  const opts: Options = {
    ...(url && {
      protocol: url.protocol,
      hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
      ...(url.port !== "" && { port: Number(url.port) }),
    }),
    ...(extra && typeof extra === "object" ? (extra as Options) : undefined),
  }
  if (opts.socketPath) return undefined
  const fallback = (opts.protocol ?? protocol) === "https:" ? 443 : 80
  const host = opts[CHECKED] ?? String(opts.hostname || opts.host || "localhost")
  return { host, port: Number(opts.port || opts.defaultPort || fallback) }
}

/** Arguments of dgram's send(msg, [offset, length,] port, [address], [callback]). */
export function datagram(args: unknown[]) {
  const ranged = typeof args[1] === "number" && typeof args[2] === "number" && typeof args[3] === "number"
  const port = ranged ? args[3] : args[1]
  const host = ranged ? args[4] : args[2]
  if (typeof port !== "number") return undefined // connected socket: checked at connect
  return { host: typeof host === "string" ? host : "localhost", port }
}

function replace<T extends object, K extends keyof T>(owner: T, name: K, make: (real: T[K]) => T[K]) {
  const real = owner[name]
  if (typeof real !== "function") return
  const next = make(real)
  try {
    Object.defineProperty(owner, name, { value: next, writable: true, configurable: true })
  } catch {
    // Non-configurable but writable (Bun.connect, Bun.spawn): plain assignment still works.
    ;(owner as Record<K, T[K]>)[name] = next
  }
  if (owner[name] !== next) throw new Error(`hardening: could not guard ${String(name)}`)
}

/** A stand-in for a runtime network client the build does not use (Bun.sql, Bun.s3, ...). Any use is denied. */
function refused(scope: Scope, via: string) {
  const fail = () => {
    record({ scope, host: "*", via })
    throw new EgressDeniedError("*", scope, via)
  }
  return new Proxy(function () {}, {
    apply: fail,
    construct: fail,
    get: (_, prop) => (typeof prop === "symbol" ? undefined : fail()),
  })
}

/**
 * Installs the process-wide egress guard. Idempotent. Throws if any hook cannot be installed, so a
 * runtime change that breaks the guard fails loudly at startup instead of silently allowing egress.
 * `Bun.fetch` is read-only and cannot be wrapped: in the CLI it goes through the proxy variables.
 */
export function install(opts: GuardOptions) {
  const holder = globalThis as Holder
  if (holder[key]) return
  const scope = opts.scope

  replace(globalThis, "fetch", (real) => wrapFetch(real, opts))

  const Real = globalThis.WebSocket
  if (typeof Real === "function") {
    class Guarded extends Real {
      constructor(url: string | URL, protocols?: string | string[] | { proxy?: unknown }) {
        permitUrl(scope, String(url), "WebSocket")
        // Bun's options form can name a proxy, which is the real network peer.
        const proxy = protocols && typeof protocols === "object" && !Array.isArray(protocols) ? protocols.proxy : undefined
        if (proxy != null) permitUrl(scope, typeof proxy === "string" ? proxy : String((proxy as { url?: unknown }).url), "WebSocket proxy")
        super(url, protocols as string | string[])
      }
    }
    Object.defineProperty(globalThis, "WebSocket", { value: Guarded, writable: true, configurable: true })
  }

  if (typeof Bun !== "undefined") {
    replace(Bun, "connect", (real) =>
      ((options: { hostname?: string; host?: string; port?: number; unix?: string }) => {
        // Bun.connect returns a promise: a denial rejects it like any other connection failure.
        if (options.unix) return real(options as Parameters<typeof real>[0])
        return Promise.resolve()
          .then(() => permit(scope, String(options.hostname || options.host || "localhost"), options.port, "Bun.connect"))
          .then(() => real(options as Parameters<typeof real>[0]))
      }) as typeof real,
    )

    type Udp = { send: (...args: unknown[]) => unknown; sendMany: (packets: unknown[]) => unknown }
    replace(Bun, "udpSocket", (real) =>
      (async (options: { connect?: { hostname: string; port: number } }) => {
        if (options?.connect) permit(scope, options.connect.hostname, options.connect.port, "Bun.udpSocket")
        const socket = (await real(options as Parameters<typeof real>[0])) as unknown as Udp
        if (options?.connect) return socket
        const send = socket.send.bind(socket)
        const many = socket.sendMany.bind(socket)
        // node:dgram connects these sockets itself (its connect is guarded); a connected socket sends
        // to its remote address without naming one.
        const remote = () => (socket as unknown as { remoteAddress?: { address: string; port: number } }).remoteAddress
        socket.send = (...args: unknown[]) => {
          // Forward the caller's arguments as given: Bun's connected form takes the data alone.
          const peer = args.length < 3 ? remote() : { address: String(args[2]), port: Number(args[1]) }
          if (peer) permit(scope, peer.address, peer.port, "Bun.udpSocket.send")
          return send(...args)
        }
        socket.sendMany = (packets: unknown[]) => {
          if (!remote())
            for (let i = 0; i + 2 < packets.length; i += 3)
              permit(scope, String(packets[i + 2]), Number(packets[i + 1]), "Bun.udpSocket.send")
          return many(packets)
        }
        return socket
      }) as unknown as typeof real,
    )

    // Bun.file/Bun.write take s3:// paths and talk to S3 natively.
    const s3 = (path: unknown) => (typeof path === "string" || path instanceof URL) && /^s3:/i.test(String(path))
    for (const name of ["file", "write"] as const)
      replace(Bun, name, (real) =>
        ((...args: unknown[]) => {
          if (s3(args[0])) permitUrl(scope, String(args[0]), `Bun.${name}`)
          return (real as (...args: unknown[]) => unknown)(...args)
        }) as typeof real,
      )

    // Built-in database and storage clients connect natively, past every hook above; nothing in the
    // build uses them, so they are switched off rather than guarded.
    const owner = Bun as unknown as Record<string, unknown>
    for (const name of ["sql", "SQL", "redis", "RedisClient", "s3", "S3Client"]) {
      if (!(name in owner)) continue
      const stub = refused(scope, `Bun.${name}`)
      owner[name] = stub
      if (owner[name] !== stub) throw new Error(`hardening: could not disable Bun.${name}`)
    }
  }

  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const dest = socketTarget(args)
    if (dest) permit(scope, dest.host, dest.port, "net.Socket.connect")
    return (connect as (...args: unknown[]) => net.Socket).apply(this, args)
  } as typeof connect

  for (const name of ["connect", "createConnection"] as const)
    replace(net, name, (real) =>
      ((...args: unknown[]) => {
        const dest = socketTarget(args)
        if (dest) permit(scope, dest.host, dest.port, `net.${name}`)
        return (real as (...args: unknown[]) => net.Socket)(...args)
      }) as typeof real,
    )

  replace(tls, "connect", (real) =>
    ((...args: unknown[]) => {
      const dest = socketTarget(args)
      if (dest) permit(scope, dest.host, dest.port, "tls.connect")
      return (real as (...args: unknown[]) => tls.TLSSocket)(...args)
    }) as typeof real,
  )

  for (const [mod, protocol] of [
    [http, "http:"],
    [https, "https:"],
  ] as const)
    for (const name of ["request", "get"] as const)
      replace(mod, name, (real) =>
        ((...args: unknown[]) => {
          const dest = requestTarget(args, protocol)
          if (dest) permit(scope, dest.host, dest.port, `${protocol.slice(0, -1)}.${name}`)
          return (real as (...args: unknown[]) => http.ClientRequest)(...args)
        }) as typeof real,
      )

  // Bun's http client does not go through net, so a directly constructed request is checked here.
  // A function, not a class: legacy subclasses call ClientRequest.call(this, ...) without `new`.
  replace(http, "ClientRequest", (Request) => {
    function Guarded(this: unknown, ...args: unknown[]) {
      const dest = requestTarget(args, "http:")
      if (dest) permit(scope, dest.host, dest.port, "http.ClientRequest")
      if (new.target) return Reflect.construct(Request, args, new.target)
      return (Request as unknown as (...args: unknown[]) => unknown).apply(this, args)
    }
    Guarded.prototype = Request.prototype
    Object.setPrototypeOf(Guarded, Request)
    return Guarded as unknown as typeof Request
  })

  const send = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: unknown[]) {
    const dest = datagram(args)
    if (dest) permit(scope, dest.host, dest.port, "dgram.send")
    return (send as (...args: unknown[]) => void).apply(this, args)
  } as typeof send
  const attach = dgram.Socket.prototype.connect
  dgram.Socket.prototype.connect = function (this: dgram.Socket, ...args: unknown[]) {
    permit(scope, typeof args[1] === "string" ? args[1] : "localhost", Number(args[0]), "dgram.connect")
    return (attach as (...args: unknown[]) => void).apply(this, args)
  } as typeof attach

  holder[key] = opts
}

/** The options the guard was installed with, or undefined if this process is unguarded. */
export function installed(): GuardOptions | undefined {
  return (globalThis as Holder)[key]
}
