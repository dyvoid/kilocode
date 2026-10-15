import { lookup } from "node:dns/promises"
import { config, entries, type Config, type Scope } from "./config"
import { EgressDeniedError } from "./error"
import { allowsAddress, check, describe, normalize, urlPort, type Entry } from "./match"
import { record } from "./log"

const lists = new Map<Scope, readonly Entry[]>()

function list(scope: Scope, cfg: Config = config) {
  if (cfg !== config) return entries(cfg, scope)
  const cached = lists.get(scope)
  if (cached) return cached
  const value = entries(cfg, scope)
  lists.set(scope, value)
  return value
}

function deny(scope: Scope, host: string, via: string): never {
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

/** Parses a URL-like input and applies `permit`. Non-network schemes (data:, blob:, file:) pass. */
export function permitUrl(scope: Scope, input: string | URL, via: string) {
  const url = typeof input === "string" ? new URL(input) : input
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return url
  permit(scope, url.hostname, urlPort(url), via)
  return url
}

export async function permitUrlAsync(scope: Scope, input: string | URL, via: string) {
  const url = typeof input === "string" ? new URL(input) : input
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return url
  await permitAsync(scope, url.hostname, urlPort(url), via)
  return url
}

/**
 * Validates a user- or config-supplied endpoint (provider base URL, indexing endpoint) against a scope.
 * Returns an error message for the UI, or undefined when the URL is allowed. Never logs: this is
 * input validation, not an egress attempt.
 */
export function validateEndpoint(input: string, scope: Scope = "app", cfg: Config = config) {
  const url = URL.canParse(input) ? new URL(input) : undefined
  if (!url || !["http:", "https:"].includes(url.protocol)) return `"${input}" is not a valid http(s) URL.`
  const verdict = check(list(scope, cfg), url.hostname, urlPort(url))
  if (verdict === "allow") return undefined
  const allowed = list(scope, cfg).map(describe)
  const hint = allowed.length > 0 ? `Allowed: localhost, ${allowed.join(", ")}.` : "Only localhost is allowed."
  if (verdict === "resolve")
    return `${url.hostname} is not listed by name. It is allowed only if it resolves into an allowed address range. ${hint}`
  return `${url.hostname} is not on this build's allowlist. ${hint}`
}

/** Fails fast on a build whose default provider points outside its own allowlist. */
export function assertConsistent(cfg: Config = config) {
  const problem = validateEndpoint(cfg.provider.baseURL, "app", cfg)
  if (problem && !problem.includes("resolves into")) throw new Error(`hardening.config.json: provider.baseURL: ${problem}`)
}
