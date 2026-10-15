import { isIP } from "node:net"
import { config as baked, entries, validateEndpoint, type Config as Baked, type Entry } from "@kilocode/kilo-hardening"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { isIndexingPlugin } from "@kilocode/kilo-indexing/detect"
import { backendSupport } from "@kilocode/sandbox"

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
  subagent_model?: string | null
  memory_model?: string | null
  command?: Record<string, { model?: string; [key: string]: unknown } | undefined>
  plugin?: ConfigPluginV1.Spec[]
  plugin_origins?: ConfigPlugin.Origin[]
  share?: "manual" | "auto" | "disabled"
  autoshare?: boolean
  autoupdate?: boolean | "notify"
  sandbox?: { enabled?: boolean; network?: "allow" | "deny"; writable_paths?: string[]; allowed_hosts?: string[] }
  mcp?: Record<string, Mcp | { enabled: boolean }>
  instructions?: string[]
  skills?: { paths?: readonly string[]; urls?: readonly string[] }
  experimental?: { image_generation?: boolean; [key: string]: unknown }
  permission?: Permission
  agent?: Record<string, { permission?: Permission; [key: string]: unknown } | undefined>
  mode?: Record<string, { permission?: Permission; [key: string]: unknown } | undefined>
  web_search?: boolean
  indexing?: {
    enabled?: boolean
    provider?: string
    vectorStore?: string
    ollama?: { baseUrl?: string }
    "openai-compatible"?: { baseUrl?: string }
    qdrant?: { url?: string }
    [key: string]: unknown
  }
}

type Permission = string | Record<string, unknown>

/**
 * Web tool permissions from the build: search uses websearch.permission when a provider is configured
 * (deny otherwise), fetch is denied when the build turns it off. Applied to the global and every
 * per-agent permission block, because per-agent config is merged last.
 */
function tools(cfg: Shape, build: Baked) {
  const search = build.websearch.providers.length > 0 ? build.websearch.permission : "deny"
  // Rules are evaluated last-match-wins in key order, so the forced keys are removed and appended last.
  const force = (value: Permission | undefined) => {
    const base: Record<string, unknown> = { ...(typeof value === "string" ? { "*": value } : value) }
    delete base.websearch
    if (build.webfetch === "off") delete base.webfetch
    return { ...base, websearch: search, ...(build.webfetch === "off" && { webfetch: "deny" }) }
  }
  cfg.permission = force(cfg.permission)
  for (const group of [cfg.agent, cfg.mode])
    for (const item of Object.values(group ?? {})) if (item?.permission !== undefined) item.permission = force(item.permission)
  cfg.web_search = build.websearch.providers.length > 0
}

/** Embedders that run against a host the build controls; every other one is a cloud service. */
const EMBEDDERS = new Set(["ollama", "openai-compatible"])

/**
 * Why the restricted build cannot run this indexing config, or undefined when it can. Checked by the
 * config layer and again where indexing starts, because the VS Code extension enables indexing by
 * consent rather than through `indexing.enabled`.
 */
export function indexingProblem(item: NonNullable<Shape["indexing"]>, build: Baked = baked): Warning | undefined {
  if (!item.provider || !EMBEDDERS.has(item.provider))
    return {
      path: "indexing.provider",
      message: "Indexing disabled: use the ollama or openai-compatible embedder with a host on the allowlist.",
    }
  const endpoints = [
    ["indexing.ollama.baseUrl", item.provider === "ollama" ? (item.ollama?.baseUrl ?? "http://localhost:11434") : undefined],
    ["indexing.openai-compatible.baseUrl", item.provider === "openai-compatible" ? item["openai-compatible"]?.baseUrl : undefined],
    ["indexing.qdrant.url", item.vectorStore === "qdrant" ? item.qdrant?.url : undefined],
  ] as const
  for (const [path, url] of endpoints) {
    if (!url) continue
    const problem = validateEndpoint(url, "app", build)
    if (problem) return { path, message: "Indexing disabled.", detail: problem }
  }
  // LanceDB is installed from the npm registry on first use unless the build ships it (KILO_LANCEDB_PATH).
  if ((item.vectorStore ?? "lancedb") === "lancedb" && !process.env.KILO_LANCEDB_PATH)
    return {
      path: "indexing.vectorStore",
      message: 'Indexing disabled: LanceDB is not bundled with this build. Set "indexing.vectorStore" to "qdrant".',
    }
}

function indexing(cfg: Shape, warnings: Warning[], build: Baked) {
  const item = cfg.indexing
  if (!item) return
  const problem = indexingProblem(item, build)
  if (!problem) return
  cfg.indexing = { ...item, enabled: false }
  // Only worth a warning when the user turned indexing on; VS Code consent hits the check at start-up.
  if (item.enabled) warnings.push(problem)
}

function remote(value: string) {
  return value.startsWith("http://") || value.startsWith("https://")
}

/** Merges the build's default provider under any user edits, so users can add or rename models. */
function provider(cfg: Shape, build: NonNullable<Baked["provider"]>) {
  const user = cfg.provider?.[build.id] ?? undefined
  const models = Object.fromEntries(
    Object.entries(build.models).map(([id, model]) => [id, { name: model.name, ...(model.limit && { limit: model.limit }) }]),
  )
  return {
    ...user,
    npm: PROVIDER_NPM,
    name: user?.name ?? build.name,
    options: { ...user?.options, baseURL: user?.options?.baseURL ?? build.baseURL },
    models: { ...models, ...user?.models },
  } satisfies Provider
}

/**
 * Applies the restricted build's policy to a fully merged config. Called last in config loading, so it
 * decides the final provider set, sandbox and remote sources regardless of user, project or org config.
 * Every change that drops something the user configured is reported as a warning.
 */
export function apply<T extends Shape>(
  cfg: T,
  warnings: Warning[],
  build: Baked = baked,
  support: (hosts: string[]) => { available: boolean; reason?: string } = (hosts) =>
    backendSupport({ mode: hosts.length > 0 ? "proxy" : "deny", allowedHosts: hosts }),
): T {
  // Providers: the build's generic provider (when the build has one) plus any user-defined
  // OpenAI-compatible provider whose base URL is on the allowlist. Everything else (built-in catalog
  // providers, the Kilo gateway) is off.
  const preset = build.provider
  const rest = Object.entries(cfg.provider ?? {}).filter(([id]) => id !== preset?.id)
  const providers: Record<string, Provider | null> = {
    ...(preset && { [preset.id]: provider(cfg, preset) }),
    ...Object.fromEntries(rest),
  }
  const enabled: string[] = []
  // A provider the user (or their org) disabled stays disabled.
  const disabled = new Set(cfg.disabled_providers ?? [])
  for (const [id, item] of Object.entries(providers)) {
    if (!item || disabled.has(id)) continue
    if (id === "kilo") {
      warnings.push({ path: "provider.kilo", message: 'Provider disabled: the id "kilo" is reserved for the Kilo gateway.' })
      continue
    }
    if (item.npm !== undefined && item.npm !== PROVIDER_NPM) {
      if (id !== preset?.id && cfg.provider?.[id])
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
    // Without `npm` upstream would take the catalog's SDK for a known id (openai, anthropic, ...): pin it.
    // Per-model SDK overrides are dropped for the same reason.
    const models = Object.fromEntries(
      Object.entries(item.models ?? {}).map(([name, model]) => {
        const sdk = (model as { provider?: { npm?: string } } | undefined)?.provider?.npm
        if (sdk === undefined || sdk === PROVIDER_NPM) return [name, model]
        warnings.push({ path: `provider.${id}.models.${name}.provider.npm`, message: "Model SDK override removed: this build only supports OpenAI-compatible providers." })
        const rest = { ...(model as Record<string, unknown>) }
        delete rest.provider
        return [name, rest]
      }),
    )
    providers[id] = { ...item, npm: PROVIDER_NPM, ...(item.models && { models }) } as Provider
    enabled.push(id)
  }
  cfg.provider = providers
  cfg.enabled_providers = enabled
  // "kilo" listed explicitly: the extension shows the Kilo Gateway card unless it is disabled.
  cfg.disabled_providers = [...new Set([...disabled, "kilo"])]

  // Models: every reference must name an enabled provider, or it is dropped (with a warning when the
  // user set it) so the default applies instead of a "model not found" at run time.
  const first = preset && Object.keys(preset.models)[0]
  const fallback = preset && first && enabled.includes(preset.id) ? `${preset.id}/${first}` : undefined
  const usable = (ref: string | null | undefined) => !!ref && enabled.includes(ref.split("/")[0])
  const dropped = (path: string, ref: string | null | undefined) => {
    if (ref) warnings.push({ path, message: `Model ${ref} is not available in this build; using the default.` })
  }
  if (!usable(cfg.model)) {
    dropped("model", cfg.model)
    cfg.model = fallback ?? null
  }
  if (!usable(cfg.small_model)) {
    dropped("small_model", cfg.small_model)
    cfg.small_model = cfg.model ?? null
  }
  for (const key of ["subagent_model", "memory_model"] as const)
    if (cfg[key] && !usable(cfg[key])) {
      dropped(key, cfg[key])
      delete cfg[key]
    }
  for (const [group, items] of [
    ["agent", cfg.agent],
    ["mode", cfg.mode],
    ["command", cfg.command],
  ] as const)
    for (const [name, item] of Object.entries(items ?? {})) {
      const ref = item?.model
      if (!item || typeof ref !== "string" || usable(ref)) continue
      dropped(`${group}.${name}.model`, ref)
      delete item.model
    }

  // Plugins: only the built-in indexing plugin and local file plugins. npm plugins need the registry.
  const keep = (spec: ConfigPluginV1.Spec) =>
    isIndexingPlugin(spec) || ConfigPlugin.pluginSpecifier(spec).startsWith("file://")
  for (const spec of cfg.plugin ?? [])
    if (!keep(spec) && !ConfigPlugin.pluginSpecifier(spec).includes("atomic-chat"))
      warnings.push({ path: "plugin", message: `Plugin ${ConfigPlugin.pluginSpecifier(spec)} disabled: npm plugins are not available in this build.` })
  cfg.plugin = (cfg.plugin ?? []).filter(keep)
  if (cfg.plugin_origins) cfg.plugin_origins = cfg.plugin_origins.filter((item) => keep(item.spec))

  // Image generation goes through the Kilo gateway; it stays off unless the build re-enables it.
  if (!build.features.imageGeneration && cfg.experimental?.image_generation)
    cfg.experimental = { ...cfg.experimental, image_generation: false }

  cfg.share = "disabled"
  cfg.autoshare = false
  cfg.autoupdate = false

  // Agent commands run sandboxed (Linux/macOS) with network limited to the tools scope. Where no backend
  // is available (Windows, or Linux without bubblewrap) commands still go through the tools-scope proxy.
  // The sandbox's own proxy takes exact "name:port" destinations on public addresses only: IP, range and
  // suffix entries cannot be expressed, so sandboxed commands cannot reach them.
  const list = entries(build, "tools")
  const named = list.filter((item): item is Extract<Entry, { kind: "host" }> => item.kind === "host" && !isIP(item.host))
  const hosts = named.flatMap((item) => (item.ports ?? [443, 80]).map((port) => `${item.host}:${port}`))
  const sandbox = build.sandbox ? support(hosts) : undefined
  if (sandbox && !sandbox.available)
    warnings.push({
      path: "sandbox",
      message: "Command sandbox unavailable on this system; agent commands are limited by the network proxy only.",
      ...(sandbox.reason && { detail: sandbox.reason }),
    })
  // Entries the sandbox cannot express are reported when the VSIX is built (see sandboxNotes), not on every start.
  if (sandbox?.available) cfg.sandbox = { ...cfg.sandbox, enabled: true, network: "deny", allowed_hosts: hosts }

  // Remote MCP servers run in-process; they get the tools scope (local ones inherit the tools proxy).
  for (const [name, item] of Object.entries(cfg.mcp ?? {})) {
    if (!("url" in item) || typeof item.url !== "string") continue
    const problem = validateEndpoint(item.url, "tools", build)
    if (!problem) continue
    cfg.mcp![name] = { ...item, enabled: false }
    warnings.push({ path: `mcp.${name}.url`, message: "MCP server disabled.", detail: problem })
  }

  indexing(cfg, warnings, build)
  tools(cfg, build)

  const allowed = (value: string) => !remote(value) || !validateEndpoint(value, "app", build)
  for (const value of cfg.instructions ?? [])
    if (!allowed(value)) warnings.push({ path: "instructions", message: `Remote instructions not loaded: ${value}` })
  if (cfg.instructions) cfg.instructions = cfg.instructions.filter(allowed)
  for (const value of cfg.skills?.urls ?? [])
    if (!allowed(value)) warnings.push({ path: "skills.urls", message: `Remote skills not loaded: ${value}` })
  if (cfg.skills?.urls) cfg.skills = { ...cfg.skills, urls: cfg.skills.urls.filter(allowed) }

  return cfg
}
