import { config, entries } from "../config"
import { record } from "../log"
import { check, urlPort } from "../match"

/** Extension IDs whose vscode:// URI handler links may open. */
// The upstream ID matters in dev builds only: the VSIX identity transform rewrites it to this build's ID.
const OWN = [`${config.identity.publisher}.${config.identity.name}`, "kilocode.kilo-code"]

/**
 * Whether an external link may open. http(s) links open only to hosts on the allowlist (internal docs,
 * MCP sign-in on an allowed server) unless the build enables external links. Other schemes are handed to
 * OS or VS Code handlers that connect on their own (ssh:, smb:, file://host, vscode://vscode.git/clone),
 * so only mailto: and this extension's own vscode:// handler pass.
 */
export function allowed(target: string) {
  const url = URL.canParse(target) ? new URL(target) : undefined
  if (!url) return false
  if (url.protocol === "mailto:") return true
  if (url.protocol === "vscode:" || url.protocol === "vscode-insiders:") return OWN.includes(url.hostname)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (config.features.externalLinks) return true
  return check(entries(config, "cli"), url.hostname, urlPort(url)) === "allow"
}

export function refused(target: string) {
  const host = URL.canParse(target) ? new URL(target).hostname : target
  record({ scope: "app", host, via: "openExternal" })
}
