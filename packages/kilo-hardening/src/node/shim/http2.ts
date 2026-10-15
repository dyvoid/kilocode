// Bundle-scoped replacement for `http2` / `node:http2` (see esbuild.cjs).
import real from "node:http2"
import { permitUrl } from "../../policy"
import { view } from "./view"

export const connect = ((authority: string | URL, ...rest: unknown[]) => {
  permitUrl("app", String(authority), "http2.connect")
  return (real.connect as (...args: unknown[]) => real.ClientHttp2Session)(authority, ...rest)
}) as typeof real.connect

export const { constants, createSecureServer, createServer, getDefaultSettings, getPackedSettings, getUnpackedSettings, sensitiveHeaders } = real

export default view(real, { connect })
