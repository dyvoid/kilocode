import { config as baked, entries, validateEndpoint, type Config as Baked } from "@kilocode/kilo-hardening"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { isIndexingPlugin } from "@kilocode/kilo-indexing/detect"

/** The only provider SDK the restricted build allows: bundled, so it never triggers an npm install. */
export const PROVIDER_NPM = "@ai-sdk/openai-compatible"

type Warning = { path: string; message: string; detail?: string }

type Provider = {
  npm?: string
  name?: string
  options?: { baseURL?: string; [key: string]: unknown }
  models?: Record<string, unknown>
  [key: string]: unknown
}

type Mcp = { type?: string; url?: string; enabled?: boolean; [key: string]: unknown }

/** The subset of Config.Info this layer reads and writes. */
export type Shape = {
  provider?: Record<string, Provider | null>
  enabled_providers?: string[]
  disabled_providers?: string[]
  model?: string | null
  small_model?: string | null
  plugin?: ConfigPluginV1.Spec[]
  plugin_origins?: ConfigPlugin.Origin[]
  share?: "manual" | "auto" | "disabled"
  autoshare?: boolean
  autoupdate?: boolean | "notify"
  sandbox?: { enabled?: boolean; network?: "allow" | "deny"; writable_paths?: string[]; allowed_hosts?: string[] }
  mcp?: Record<string, Mcp | { enabled: boolean }>
  instructions?: string[]
  skills?: { paths?: readonly string[]; urls?: readonly string[] }
}

function remote(value: string) {
  return value.startsWith("http://") || value.startsWith("https://")
}

/** Merges the build's default provider under any user edits, so users can add or rename models. */
function provider(cfg: Shape, build: Baked) {
  const user = cfg.provider?.[build.provider.id] ?? undefined
  const models = Object.fromEntries(
    Object.entries(build.provider.models).map(([id, model]) => [id, { name: model.name, ...(model.limit && { limit: model.limit }) }]),
  )
  return {
    ...user,
    npm: PROVIDER_NPM,
    name: user?.name ?? build.provider.name,
    options: { ...user?.options, baseURL: user?.options?.baseURL ?? build.provider.baseURL },
    models: { ...models, ...user?.models },
  } satisfies Provider
}

/**
 * Applies the restricted build's policy to a fully merged config. Called last in config loading, so it
 * decides the final provider set, sandbox and remote sources regardless of user, project or org config.
 * Every change that drops something the user configured is reported as a warning.
 */
export function apply<T extends Shape>(cfg: T, warnings: Warning[], build: Baked = baked): T {
  // Providers: the build's generic provider plus any user-defined OpenAI-compatible provider whose
  // base URL is on the allowlist. Everything else (built-in catalog providers, the Kilo gateway) is off.
  const rest = Object.entries(cfg.provider ?? {}).filter(([id]) => id !== build.provider.id)
  const providers: Record<string, Provider | null> = {
    [build.provider.id]: provider(cfg, build),
    ...Object.fromEntries(rest),
  }
  const enabled: string[] = []
  for (const [id, item] of Object.entries(providers)) {
    if (!item) continue
    if (item.npm !== PROVIDER_NPM) {
      if (id !== build.provider.id && cfg.provider?.[id])
        warnings.push({
          path: `provider.${id}`,
          message: "Provider disabled: this build only supports OpenAI-compatible providers.",
        })
      continue
    }
    const url = item.options?.baseURL
    const problem = typeof url === "string" ? validateEndpoint(url, "app", build) : `provider ${id} has no baseURL.`
    if (problem) {
      warnings.push({ path: `provider.${id}.options.baseURL`, message: "Provider disabled.", detail: problem })
      continue
    }
    enabled.push(id)
  }
  cfg.provider = providers
  cfg.enabled_providers = enabled
  cfg.disabled_providers = (cfg.disabled_providers ?? []).filter((id) => !enabled.includes(id))

  const first = Object.keys(build.provider.models)[0]
  const fallback = enabled.includes(build.provider.id) && first ? `${build.provider.id}/${first}` : undefined
  const usable = (ref: string | null | undefined) => !!ref && enabled.includes(ref.split("/")[0])
  if (!usable(cfg.model)) cfg.model = fallback ?? null
  if (!usable(cfg.small_model)) cfg.small_model = cfg.model ?? null

  // Plugins: only the built-in indexing plugin and local file plugins. npm plugins need the registry.
  const keep = (spec: ConfigPluginV1.Spec) =>
    isIndexingPlugin(spec) || ConfigPlugin.pluginSpecifier(spec).startsWith("file://")
  for (const spec of cfg.plugin ?? [])
    if (!keep(spec) && !ConfigPlugin.pluginSpecifier(spec).includes("atomic-chat"))
      warnings.push({ path: "plugin", message: `Plugin ${ConfigPlugin.pluginSpecifier(spec)} disabled: npm plugins are not available in this build.` })
  cfg.plugin = (cfg.plugin ?? []).filter(keep)
  if (cfg.plugin_origins) cfg.plugin_origins = cfg.plugin_origins.filter((item) => keep(item.spec))

  cfg.share = "disabled"
  cfg.autoshare = false
  cfg.autoupdate = false

  // Agent commands run sandboxed (Linux/macOS) with network limited to the tools scope.
  if (build.sandbox)
    cfg.sandbox = {
      ...cfg.sandbox,
      enabled: true,
      network: "deny",
      allowed_hosts: entries(build, "tools").flatMap((item) => (item.kind === "host" ? [item.host] : [])),
    }

  // Remote MCP servers run in-process; they get the tools scope (local ones inherit the tools proxy).
  for (const [name, item] of Object.entries(cfg.mcp ?? {})) {
    if (!("url" in item) || typeof item.url !== "string") continue
    const problem = validateEndpoint(item.url, "tools", build)
    if (!problem) continue
    cfg.mcp![name] = { ...item, enabled: false }
    warnings.push({ path: `mcp.${name}.url`, message: "MCP server disabled.", detail: problem })
  }

  const allowed = (value: string) => !remote(value) || !validateEndpoint(value, "app", build)
  for (const value of cfg.instructions ?? [])
    if (!allowed(value)) warnings.push({ path: "instructions", message: `Remote instructions not loaded: ${value}` })
  if (cfg.instructions) cfg.instructions = cfg.instructions.filter(allowed)
  for (const value of cfg.skills?.urls ?? [])
    if (!allowed(value)) warnings.push({ path: "skills.urls", message: `Remote skills not loaded: ${value}` })
  if (cfg.skills?.urls) cfg.skills = { ...cfg.skills, urls: cfg.skills.urls.filter(allowed) }

  return cfg
}
