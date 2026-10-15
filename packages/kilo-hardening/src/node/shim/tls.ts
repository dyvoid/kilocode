// Bundle-scoped replacement for `tls` / `node:tls` (see esbuild.cjs).
import real from "node:tls"
import { socketTarget } from "../../guard"
import { permit } from "../../policy"
import { view } from "./view"

export const connect = ((...args: unknown[]) => {
  const dest = socketTarget(args)
  if (dest) permit("app", dest.host, dest.port, "tls.connect")
  return (real.connect as (...args: unknown[]) => real.TLSSocket)(...args)
}) as typeof real.connect

export const {
  CLIENT_RENEG_LIMIT,
  CLIENT_RENEG_WINDOW,
  DEFAULT_CIPHERS,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MAX_VERSION,
  DEFAULT_MIN_VERSION,
  Server,
  checkServerIdentity,
  createSecureContext,
  createServer,
  getCiphers,
  rootCertificates,
} = real

/** For `new tls.TLSSocket(...).connect(...)`: checked like tls.connect. */
export class TLSSocket extends real.TLSSocket {
  static override [Symbol.hasInstance](value: unknown) {
    return value instanceof real.TLSSocket
  }
  override connect(...args: unknown[]) {
    const dest = socketTarget(args)
    if (dest) permit("app", dest.host, dest.port, "tls.TLSSocket.connect")
    return (super.connect as (...args: unknown[]) => this)(...args)
  }
}

export default view(real, { connect, TLSSocket })
