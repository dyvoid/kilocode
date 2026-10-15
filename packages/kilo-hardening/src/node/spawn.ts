import { PROXY_CLI, PROXY_TOOLS } from "../env"
import type { ProxyHandle } from "./proxy"

const LOOPBACK = "127.0.0.1,localhost,::1"

/**
 * Environment the extension sets on the CLI it spawns. Spread it last so neither the user's shell nor
 * other extension settings can override it. Child processes of the CLI inherit HTTP(S)_PROXY and so
 * use the tools-scope proxy; the CLI's own fetches use the cli-scope proxy (app and tools hosts) explicitly.
 */
export function buildSpawnEnv(proxy: ProxyHandle): Record<string, string> {
  const tools = proxy.url.tools
  return {
    [PROXY_CLI]: proxy.url.cli,
    [PROXY_TOOLS]: tools,
    HTTP_PROXY: tools,
    HTTPS_PROXY: tools,
    ALL_PROXY: tools,
    http_proxy: tools,
    https_proxy: tools,
    all_proxy: tools,
    NO_PROXY: LOOPBACK,
    no_proxy: LOOPBACK,
    // Telemetry is hard-off in the CLI regardless; this keeps the spawn intent explicit.
    KILO_TELEMETRY_LEVEL: "off",
  }
}
