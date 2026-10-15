import { config, entries } from "../config"
import { record } from "../log"
import { check, urlPort } from "../match"

/**
 * Whether an external link may open in the system browser. http(s) links open only to hosts on the
 * allowlist (internal docs, MCP sign-in on an allowed server) unless the build enables external links.
 * Non-web schemes (vscode:, command URIs, mailto:) are not network egress from the extension and pass.
 */
export function allowed(target: string) {
  if (config.features.externalLinks) return true
  const url = URL.canParse(target) ? new URL(target) : undefined
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return true
  return (["app", "tools"] as const).some((scope) => check(entries(config, scope), url.hostname, urlPort(url)) === "allow")
}

export function refused(target: string) {
  const host = URL.canParse(target) ? new URL(target).hostname : target
  record({ scope: "app", host, via: "openExternal" })
}
