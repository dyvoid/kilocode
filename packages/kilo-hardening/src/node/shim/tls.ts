// Bundle-scoped replacement for `tls` / `node:tls` (see esbuild.cjs).
import real from "node:tls"
import { socketTarget } from "../../guard"
import { permit } from "../../policy"

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
  TLSSocket,
  checkServerIdentity,
  createSecureContext,
  createServer,
  getCiphers,
  rootCertificates,
} = real

export default { ...real, connect }
