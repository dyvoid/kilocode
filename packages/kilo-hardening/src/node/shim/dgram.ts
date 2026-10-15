// Bundle-scoped replacement for `dgram` / `node:dgram` (see esbuild.cjs). Sockets created here check every
// destination; the shared prototype is left alone.
import real from "node:dgram"
import { datagram } from "../../guard"
import { permit } from "../../policy"
import { view } from "./view"

export const createSocket = ((...args: unknown[]) => {
  const socket = (real.createSocket as (...args: unknown[]) => real.Socket)(...args)
  const send = socket.send.bind(socket) as (...args: unknown[]) => void
  const connect = socket.connect.bind(socket) as (...args: unknown[]) => void
  Object.assign(socket, {
    send: (...rest: unknown[]) => {
      const dest = datagram(rest)
      if (dest) permit("app", dest.host, dest.port, "dgram.send")
      return send(...rest)
    },
    connect: (...rest: unknown[]) => {
      permit("app", typeof rest[1] === "string" ? rest[1] : "localhost", Number(rest[0]), "dgram.connect")
      return connect(...rest)
    },
  })
  return socket
}) as typeof real.createSocket

/** For `new dgram.Socket(...)`: the same checks on a directly constructed socket. */
export class Socket extends real.Socket {
  static override [Symbol.hasInstance](value: unknown) {
    return value instanceof real.Socket
  }
  override send(...rest: unknown[]) {
    const dest = datagram(rest)
    if (dest) permit("app", dest.host, dest.port, "dgram.send")
    return (super.send as (...args: unknown[]) => void)(...rest)
  }
  override connect(...rest: unknown[]) {
    permit("app", typeof rest[1] === "string" ? rest[1] : "localhost", Number(rest[0]), "dgram.connect")
    return (super.connect as (...args: unknown[]) => void)(...rest)
  }
}

export default view(real, { createSocket, Socket })
