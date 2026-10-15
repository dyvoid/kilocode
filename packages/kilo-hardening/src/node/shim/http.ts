// Bundle-scoped replacement for `http` / `node:http` (see esbuild.cjs).
import real from "node:http"
import { requestTarget } from "../../guard"
import { permitUrl } from "../../policy"

function check(args: unknown[], via: string) {
  const url = requestTarget(args, "http:")
  if (url) permitUrl("app", url, via)
}

export const request = ((...args: unknown[]) => {
  check(args, "http.request")
  return (real.request as (...args: unknown[]) => real.ClientRequest)(...args)
}) as typeof real.request

export const get = ((...args: unknown[]) => {
  check(args, "http.get")
  return (real.get as (...args: unknown[]) => real.ClientRequest)(...args)
}) as typeof real.get

export const {
  Agent,
  ClientRequest,
  IncomingMessage,
  METHODS,
  OutgoingMessage,
  STATUS_CODES,
  Server,
  ServerResponse,
  createServer,
  globalAgent,
  maxHeaderSize,
  validateHeaderName,
  validateHeaderValue,
} = real

export default { ...real, request, get }
