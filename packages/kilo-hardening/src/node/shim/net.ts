// Bundle-scoped replacement for `net` / `node:net` (see esbuild.cjs). Only code inside the hardened
// bundle resolves to this module, so other extensions sharing the extension host are unaffected.
import real from "node:net"
import { socketTarget } from "../../guard"
import { permit } from "../../policy"

function check(args: unknown[], via: string) {
  const dest = socketTarget(args)
  if (dest) permit("app", dest.host, dest.port, via)
}

export class Socket extends real.Socket {
  override connect(...args: unknown[]) {
    check(args, "net.Socket.connect")
    return (super.connect as (...args: unknown[]) => this)(...args)
  }
}

export const connect = ((...args: unknown[]) => {
  check(args, "net.connect")
  return (real.connect as (...args: unknown[]) => real.Socket)(...args)
}) as typeof real.connect

export const createConnection = ((...args: unknown[]) => {
  check(args, "net.createConnection")
  return (real.createConnection as (...args: unknown[]) => real.Socket)(...args)
}) as typeof real.createConnection

export const {
  BlockList,
  Server,
  SocketAddress,
  createServer,
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
  isIP,
  isIPv4,
  isIPv6,
  setDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout,
} = real

export const Stream = Socket

export default { ...real, Socket, Stream: Socket, connect, createConnection }
