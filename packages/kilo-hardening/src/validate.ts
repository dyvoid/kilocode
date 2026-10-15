// Browser-safe (no node: imports): used by the webview as well as the CLI and extension host.
import { config, entries, type Config, type Scope } from "./config"
import { check, describe, urlPort } from "./match"

/**
 * Validates a user- or config-supplied endpoint (provider base URL, indexing endpoint) against a scope.
 * Returns an error message for the UI, or undefined when the URL is allowed. Never logs: this is
 * input validation, not an egress attempt.
 */
export function validateEndpoint(input: string, scope: Scope = "app", cfg: Config = config) {
  const url = URL.canParse(input) ? new URL(input) : undefined
  if (!url || !["http:", "https:"].includes(url.protocol)) return `"${input}" is not a valid http(s) URL.`
  const verdict = check(entries(cfg, scope), url.hostname, urlPort(url))
  if (verdict === "allow") return undefined
  const allowed = entries(cfg, scope).map(describe)
  const hint = allowed.length > 0 ? `Allowed: localhost, ${allowed.join(", ")}.` : "Only localhost is allowed."
  if (verdict === "resolve")
    return `${url.hostname} is not listed by name. It is allowed only if it resolves into an allowed address range. ${hint}`
  return `${url.hostname} is not on this build's allowlist. ${hint}`
}

