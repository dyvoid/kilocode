import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { config, SEARCH_HOSTS, type Search } from "./config"
import { file } from "./log"

/** Removes API keys carried in URL query strings (the Exa MCP endpoint takes its key as ?exaApiKey=). */
export function redact(text: string) {
  return text.replace(/([?&][\w-]*(?:api[_-]?key|key|token)=)[^&\s"'`)]+/gi, "$1[redacted]")
}

/**
 * Appends one JSON line per search (time, provider host, query) to search-audit.log next to the egress
 * log, when the build enables websearch.audit. Queries are written by the model and can contain code.
 */
export function audit(provider: string, query: string) {
  if (!config.websearch.audit) return
  const host = SEARCH_HOSTS[provider as Search] ?? provider
  const target = path.join(path.dirname(file()), "search-audit.log")
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    appendFileSync(target, `${JSON.stringify({ time: new Date().toISOString(), host, query })}\n`)
  } catch (err) {
    console.error(`[hardening] could not write ${target}:`, err)
  }
}
