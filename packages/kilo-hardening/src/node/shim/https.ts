// Bundle-scoped replacement for `https` / `node:https` (see esbuild.cjs).
import real from "node:https"
import type { ClientRequest } from "node:http"
import net from "node:net"
import { requestTarget } from "../../guard"
import { permit } from "../../policy"
import { view } from "./view"

function check(args: unknown[], via: string) {
  const dest = requestTarget(args, "https:")
  if (dest) permit("app", dest.host, dest.port, via)
}

export const request = ((...args: unknown[]) => {
  check(args, "https.request")
  return (real.request as (...args: unknown[]) => ClientRequest)(...args)
}) as typeof real.request

export const get = ((...args: unknown[]) => {
  check(args, "https.get")
  return (real.get as (...args: unknown[]) => ClientRequest)(...args)
}) as typeof real.get

/** Agents open their own sockets with the unshimmed net/tls, so their connections are checked here. */
export class Agent extends real.Agent {
  override createConnection(...args: unknown[]) {
    const opts = (args[0] ?? {}) as net.NetConnectOpts & { host?: string; port?: number }
    permit("app", String(opts.host || "localhost"), Number(opts.port || 443), "https.Agent")
    return (super.createConnection as (...args: unknown[]) => ReturnType<real.Agent["createConnection"]>)(...args)
  }
}

export const { Server, createServer } = real

/** This bundle's own default agent: the shared one opens connections without the checks above. */
export const globalAgent = new Agent({ keepAlive: true })

export default view(real, { request, get, Agent, globalAgent })
