import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import type { Scope } from "./config"
import { wrapFetch } from "./fetch"
import { permit, permitUrl } from "./policy"

export interface GuardOptions {
  scope: Scope
  /** Allowlist proxy for this process's own fetch traffic (see wrapFetch). */
  proxy?: string
}

const key = Symbol.for("kilo.hardening.guard")
type Holder = { [key]?: GuardOptions }

type Target = { host?: string | null; hostname?: string | null; port?: number | string | null; path?: string | null }

/** Extracts host and port from the overloaded (options | port, host | path) forms of net/tls connect. */
export function socketTarget(args: unknown[]): { host: string; port?: number } | undefined {
  const [first, second] = args
  if (typeof first === "string" && !/^\d+$/.test(first)) return undefined // unix socket / named pipe path
  if (typeof first === "number" || typeof first === "string")
    return { host: typeof second === "string" ? second : "localhost", port: Number(first) }
  if (first && typeof first === "object") {
    const opts = first as Target
    if (opts.path) return undefined
    return { host: String(opts.host ?? opts.hostname ?? "localhost"), port: opts.port == null ? undefined : Number(opts.port) }
  }
  return undefined
}

/** Extracts the destination of http(s).request/get's (url | options, [options]) forms. */
export function requestTarget(args: unknown[], protocol: "http:" | "https:"): URL | undefined {
  const [first, second] = args
  if (typeof first === "string" || first instanceof URL) return new URL(String(first))
  const opts = (first && typeof first === "object" ? first : second) as (Target & { protocol?: string; socketPath?: string }) | undefined
  if (!opts || opts.socketPath) return undefined
  const host = String(opts.hostname ?? opts.host ?? "localhost")
  const url = new URL(`${opts.protocol ?? protocol}//${host.includes(":") ? `[${host}]` : host}`)
  if (opts.port != null) url.port = String(opts.port)
  return url
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

/**
 * Installs the process-wide egress guard. Idempotent. Throws if any hook cannot be installed, so a
 * runtime change that breaks the guard fails loudly at startup instead of silently allowing egress.
 */
export function install(opts: GuardOptions) {
  const holder = globalThis as Holder
  if (holder[key]) return
  holder[key] = opts
  const scope = opts.scope

  replace(globalThis, "fetch", (real) => wrapFetch(real, opts))

  const Real = globalThis.WebSocket
  if (typeof Real === "function") {
    class Guarded extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        permitUrl(scope, String(url), "WebSocket")
        super(url, protocols)
      }
    }
    Object.defineProperty(globalThis, "WebSocket", { value: Guarded, writable: true, configurable: true })
  }

  if (typeof Bun !== "undefined") {
    replace(Bun, "connect", (real) =>
      ((options: { hostname?: string; port?: number; unix?: string }) => {
        if (!options.unix) permit(scope, String(options.hostname ?? "localhost"), options.port, "Bun.connect")
        return real(options as Parameters<typeof real>[0])
      }) as typeof real,
    )
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
          const url = requestTarget(args, protocol)
          if (url) permitUrl(scope, url, `${protocol.slice(0, -1)}.${name}`)
          return (real as (...args: unknown[]) => http.ClientRequest)(...args)
        }) as typeof real,
      )
}

/** The options the guard was installed with, or undefined if this process is unguarded. */
export function installed(): GuardOptions | undefined {
  return (globalThis as Holder)[key]
}
