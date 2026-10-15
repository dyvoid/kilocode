// Bundle-scoped replacement for `https` / `node:https` (see esbuild.cjs).
import real from "node:https"
import type { ClientRequest } from "node:http"
import { requestTarget } from "../../guard"
import { permitUrl } from "../../policy"

function check(args: unknown[], via: string) {
  const url = requestTarget(args, "https:")
  if (url) permitUrl("app", url, via)
}

export const request = ((...args: unknown[]) => {
  check(args, "https.request")
  return (real.request as (...args: unknown[]) => ClientRequest)(...args)
}) as typeof real.request

export const get = ((...args: unknown[]) => {
  check(args, "https.get")
  return (real.get as (...args: unknown[]) => ClientRequest)(...args)
}) as typeof real.get

export const { Agent, Server, createServer, globalAgent } = real

export default { ...real, request, get }
