import { lookup } from "node:dns/promises"
import { config, entries, type Config, type Scope } from "./config"
import { EgressDeniedError } from "./error"
import { allowsAddress, check, normalize, urlPort, type Entry } from "./match"
import { record } from "./log"
import { validateEndpoint } from "./validate"

export { validateEndpoint }

const lists = new Map<Scope, readonly Entry[]>()

function list(scope: Scope, cfg: Config = config) {
  if (cfg !== config) return entries(cfg, scope)
  const cached = lists.get(scope)
  if (cached) return cached
  const value = entries(cfg, scope)
  lists.set(scope, value)
  return value
}

/** Records and throws a denial. */
export function deny(scope: Scope, host: string, via: string): never {
  record({ scope, host, via })
  throw new EgressDeniedError(host, scope, via)
}

/**
 * Synchronous decision by name. Hosts that only a CIDR entry could allow are denied here;
 * callers that can await should use `permitAsync`, which resolves them.
 */
export function permit(scope: Scope, host: string, port: number | undefined, via: string) {
  const value = normalize(host)
  if (check(list(scope), value, port) === "allow") return
  deny(scope, value, via)
}

/** Decision by name, resolving the host when a CIDR entry could allow one of its addresses. */
export async function permitAsync(scope: Scope, host: string, port: number | undefined, via: string) {
  const value = normalize(host)
  const result = check(list(scope), value, port)
  if (result === "allow") return
  if (result === "resolve") {
    const found = await lookup(value, { all: true }).catch(() => [])
    if (found.length > 0 && found.every((item) => allowsAddress(list(scope), item.address, port))) return
  }
  deny(scope, value, via)
}

const LOCAL = ["data:", "blob:", "file:"]
const NETWORK = ["http:", "https:", "ws:", "wss:"]

/** Local schemes pass; any scheme that is neither local nor http(s)/ws(s) (Bun's s3:, for one) is denied. */
function scheme(scope: Scope, url: URL, via: string) {
  if (LOCAL.includes(url.protocol)) return "local"
  if (NETWORK.includes(url.protocol)) return "network"
  return deny(scope, `${url.protocol}//${url.hostname}`, via)
}

/** Parses a URL-like input and applies `permit`. Local schemes (data:, blob:, file:) pass. */
export function permitUrl(scope: Scope, input: string | URL, via: string) {
  const url = typeof input === "string" ? new URL(input) : input
  if (scheme(scope, url, via) === "network") permit(scope, url.hostname, urlPort(url), via)
  return url
}

export async function permitUrlAsync(scope: Scope, input: string | URL, via: string) {
  const url = typeof input === "string" ? new URL(input) : input
  if (scheme(scope, url, via) === "network") await permitAsync(scope, url.hostname, urlPort(url), via)
  return url
}

/** Fails fast on a build whose default provider points outside its own allowlist. */
export function assertConsistent(cfg: Config = config) {
  if (!cfg.provider) return
  const problem = validateEndpoint(cfg.provider.baseURL, "app", cfg)
  if (problem && !problem.includes("resolves into")) throw new Error(`hardening.config.json: provider.baseURL: ${problem}`)
}

/**
 * Build-time notes on `allow.tools` entries the command sandbox cannot express (it takes exact host
 * names and ports): IP, range and suffix entries are unreachable from sandboxed commands, and hosts
 * without a port list are opened on 443 and 80 only. Counts only, for public build logs.
 */
export function sandboxNotes(cfg: Config = config) {
  const tools = cfg.allow.tools
  const named = tools.filter((item) => item.kind === "host" && !/^[\d.]+$|:/.test(item.host))
  const unreachable = tools.length - named.length
  const portless = named.filter((item) => !item.ports).length
  return [
    ...(unreachable > 0 ? [`${unreachable} allow.tools entr${unreachable === 1 ? "y is" : "ies are"} not reachable from sandboxed commands (IP, CIDR or suffix)`] : []),
    ...(portless > 0 ? [`${portless} allow.tools host${portless === 1 ? "" : "s"} without a port list: sandboxed commands use 443 and 80 only`] : []),
  ]
}
