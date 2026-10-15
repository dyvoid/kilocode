import raw from "../hardening.config.json"
import { entry, type Entry } from "./match"

export type Scope = "app" | "tools"

export type Search = "exa" | "parallel"

export interface Model {
  name: string
  limit?: { context: number; output: number }
}

export interface Provider {
  id: string
  name: string
  baseURL: string
  models: Record<string, Model>
}

export interface Config {
  identity: { publisher: string; name: string; displayName: string }
  /** Optional preconfigured provider. Without it users add their own OpenAI-compatible provider in settings. */
  provider?: Provider
  allow: Record<Scope, Entry[]>
  features: { autocomplete: boolean; speechToText: boolean; imageGeneration: boolean; externalLinks: boolean }
  websearch: { providers: Search[]; permission: "ask" | "allow" | "deny"; audit: boolean }
  webfetch: "off" | "tools"
  sandbox: boolean
}

/** Every key is optional; these are the values a missing key gets. An empty file is a valid build config. */
export const DEFAULTS = {
  identity: { publisher: "dyvoid", name: "code-agent", displayName: "Dyvoid Code Agent" },
  features: { autocomplete: false, speechToText: false, imageGeneration: false, externalLinks: false },
  websearch: { permission: "ask", audit: false },
  webfetch: "tools",
  sandbox: true,
} as const

export const SEARCH_HOSTS: Record<Search, string> = {
  exa: "mcp.exa.ai",
  parallel: "search.parallel.ai",
}

function fail(path: string, msg: string): never {
  throw new Error(`hardening.config.json: ${path} ${msg}`)
}

function text(value: unknown, path: string, fallback?: string) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string")
  return value
}

function bool(value: unknown, path: string, fallback: boolean) {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") fail(path, "must be a boolean")
  return value
}

function object(value: unknown, path: string, optional = false) {
  if (value === undefined && optional) return {} as Record<string, unknown>
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object")
  return value as Record<string, unknown>
}

function pick<T extends string>(value: unknown, path: string, options: readonly T[], fallback: T) {
  if (value === undefined) return fallback
  if (!options.includes(value as T)) fail(path, `must be one of ${options.join(", ")}`)
  return value as T
}

function slug(value: string, path: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) fail(path, "must be lowercase letters, digits and dashes")
  return value
}

function provider(input: unknown): Provider | undefined {
  if (input === undefined) return undefined
  const item = object(input, "provider")
  const models = object(item.models, "provider.models", true)
  return {
    id: slug(text(item.id, "provider.id", "llm"), "provider.id"),
    name: text(item.name, "provider.name", "LLM"),
    baseURL: text(item.baseURL, "provider.baseURL"),
    models: Object.fromEntries(
      Object.entries(models).map(([id, model]) => {
        const entry = object(model, `provider.models.${id}`, true)
        const limit = entry.limit === undefined ? undefined : object(entry.limit, `provider.models.${id}.limit`)
        return [
          id,
          {
            name: text(entry.name, `provider.models.${id}.name`, id),
            ...(limit && { limit: { context: Number(limit.context), output: Number(limit.output) } }),
          },
        ]
      }),
    ),
  }
}

/** Validates a config object, filling every missing key with its default. Throws with the offending path. */
export function parse(input: unknown): Config {
  const root = object(input, "", true)
  const identity = object(root.identity, "identity", true)
  const allow = object(root.allow, "allow", true)
  const features = object(root.features, "features", true)
  const search = object(root.websearch, "websearch", true)

  const scopes = (["app", "tools"] as const).map((scope) => {
    const list = allow[scope] ?? []
    if (!Array.isArray(list)) fail(`allow.${scope}`, "must be an array")
    return list.map((item, index) => {
      try {
        return entry(item)
      } catch (err) {
        return fail(`allow.${scope}[${index}]`, (err as Error).message)
      }
    })
  })

  const providers = search.providers ?? []
  if (!Array.isArray(providers)) fail("websearch.providers", "must be an array")
  const build = provider(root.provider)

  return {
    identity: {
      publisher: slug(text(identity.publisher, "identity.publisher", DEFAULTS.identity.publisher), "identity.publisher"),
      name: slug(text(identity.name, "identity.name", DEFAULTS.identity.name), "identity.name"),
      displayName: text(identity.displayName, "identity.displayName", DEFAULTS.identity.displayName),
    },
    ...(build && { provider: build }),
    allow: { app: scopes[0], tools: scopes[1] },
    features: {
      autocomplete: bool(features.autocomplete, "features.autocomplete", DEFAULTS.features.autocomplete),
      speechToText: bool(features.speechToText, "features.speechToText", DEFAULTS.features.speechToText),
      imageGeneration: bool(features.imageGeneration, "features.imageGeneration", DEFAULTS.features.imageGeneration),
      externalLinks: bool(features.externalLinks, "features.externalLinks", DEFAULTS.features.externalLinks),
    },
    websearch: {
      providers: providers.map((item, index) =>
        pick(item, `websearch.providers[${index}]`, ["exa", "parallel"] as const, "exa"),
      ),
      permission: pick(search.permission, "websearch.permission", ["ask", "allow", "deny"] as const, DEFAULTS.websearch.permission),
      audit: bool(search.audit, "websearch.audit", DEFAULTS.websearch.audit),
    },
    webfetch: pick(root.webfetch, "webfetch", ["off", "tools"] as const, DEFAULTS.webfetch),
    sandbox: bool(root.sandbox, "sandbox", DEFAULTS.sandbox),
  }
}

/**
 * The effective allowlist for a scope: configured entries plus the host of each enabled
 * search provider (app scope only). Loopback is implicit in the matcher, not listed here.
 */
export function entries(cfg: Config, scope: Scope): Entry[] {
  if (scope === "tools") return cfg.allow.tools
  return [...cfg.allow.app, ...cfg.websearch.providers.map((item) => entry({ host: SEARCH_HOSTS[item] }))]
}

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}

/** The build's config. Baked in at bundle time from hardening.config.json; nothing at runtime can replace it. */
export const config: Config = freeze(parse(raw))
