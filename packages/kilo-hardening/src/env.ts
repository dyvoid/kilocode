import { entries, type Config } from "./config"
import { check, loopback, urlPort } from "./match"

/** Variables naming the loopback allowlist proxy ports, set by the extension when it spawns the CLI. */
export const PROXY_CLI = "KILO_HARDENING_CLI_PROXY"
export const PROXY_TOOLS = "KILO_HARDENING_TOOLS_PROXY"

const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]

function parse(value: string) {
  const text = value.includes("://") ? value : `http://${value}`
  return URL.canParse(text) ? new URL(text) : undefined
}

/** The CLI's own proxy, accepted only on loopback (it is the extension's allowlist proxy). */
export function cliProxy(env: NodeJS.ProcessEnv) {
  const url = parse(env[PROXY_CLI] ?? "")
  return url && loopback(url.hostname) ? url.href : undefined
}

/**
 * Proxy variables naming a proxy outside the tools scope, to be removed: the proxy is the real network
 * peer for every request that uses it, and Bun's fetch and child processes honour these variables.
 */
export function strayProxies(env: NodeJS.ProcessEnv, cfg: Config) {
  const list = entries(cfg, "tools")
  return PROXIES.flatMap((name) => {
    const value = env[name]
    if (!value) return []
    const url = parse(value)
    if (url && check(list, url.hostname, urlPort(url)) === "allow") return []
    return [{ name, url: url?.href ?? `http://${value}` }]
  })
}

/**
 * Environment the CLI forces on itself at startup (undefined = removed). Applied by `install` before
 * any flag module is evaluated, so a user's shell cannot re-enable a surface by exporting a variable.
 */
export function cliEnv(cfg: Config): Record<string, string | undefined> {
  const exa = cfg.websearch.providers.includes("exa")
  const parallel = cfg.websearch.providers.includes("parallel")
  return {
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_SHARE: "1",
    KILO_DISABLE_PRESENCE: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_LSP_DOWNLOAD: "1",
    KILO_TELEMETRY_LEVEL: "off",
    KILO_AUTO_SHARE: undefined,
    // Web-search-only experimental switches. The KILO_EXPERIMENTAL umbrella stays: it also enables Exa, but
    // the config layer denies web search unless the build configures a provider, and the guard blocks the host.
    KILO_EXPERIMENTAL_EXA: undefined,
    KILO_EXPERIMENTAL_PARALLEL: undefined,
    KILO_ENABLE_EXA: exa ? "1" : undefined,
    KILO_ENABLE_PARALLEL: parallel ? "1" : undefined,
    KILO_WEBSEARCH_PROVIDER: exa ? "exa" : parallel ? "parallel" : undefined,
    // Trace export to an OTLP collector: an allowlisted host would receive session traces.
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    OTEL_EXPORTER_OTLP_HEADERS: undefined,
  }
}

export function apply(env: NodeJS.ProcessEnv, values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
}
