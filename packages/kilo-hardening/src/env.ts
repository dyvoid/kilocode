import type { Config } from "./config"

/** Variables naming the loopback allowlist proxy ports, set by the extension when it spawns the CLI. */
export const PROXY_APP = "KILO_HARDENING_APP_PROXY"
export const PROXY_TOOLS = "KILO_HARDENING_TOOLS_PROXY"

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
  }
}

export function apply(env: NodeJS.ProcessEnv, values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
}
