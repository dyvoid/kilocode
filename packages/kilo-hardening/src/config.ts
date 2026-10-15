import raw from "../hardening.config.json"
import { entry, type Entry } from "./match"

export type Scope = "app" | "tools"

export type Search = "exa" | "parallel"

export interface Model {
  name: string
  limit?: { context: number; output: number }
}

export interface Config {
  identity: { publisher: string; name: string; displayName: string }
  provider: { id: string; name: string; baseURL: string; models: Record<string, Model> }
  allow: Record<Scope, Entry[]>
  features: { autocomplete: boolean; speechToText: boolean; imageGeneration: boolean; externalLinks: boolean }
  websearch: { providers: Search[]; permission: "ask" | "allow" | "deny"; audit: boolean }
  webfetch: "off" | "tools"
  sandbox: boolean
}

export const SEARCH_HOSTS: Record<Search, string> = {
  exa: "mcp.exa.ai",
  parallel: "search.parallel.ai",
}

function fail(path: string, msg: string): never {
  throw new Error(`hardening.config.json: ${path} ${msg}`)
}

function text(value: unknown, path: string) {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string")
  return value
}

function bool(value: unknown, path: string) {
  if (typeof value !== "boolean") fail(path, "must be a boolean")
  return value
}

function object(value: unknown, path: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object")
  return value as Record<string, unknown>
}

function pick<T extends string>(value: unknown, path: string, options: readonly T[]) {
  if (!options.includes(value as T)) fail(path, `must be one of ${options.join(", ")}`)
  return value as T
}

/** Validates a config object. Throws with the offending path on the first error. */
export function parse(input: unknown): Config {
  const root = object(input, "")
  const identity = object(root.identity, "identity")
  const provider = object(root.provider, "provider")
  const allow = object(root.allow, "allow")
  const features = object(root.features, "features")
  const search = object(root.websearch, "websearch")
  const models = object(provider.models, "provider.models")

  const name = text(identity.name, "identity.name")
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail("identity.name", "must be lowercase letters, digits and dashes")
  const publisher = text(identity.publisher, "identity.publisher")
  if (!/^[a-z0-9][a-z0-9-]*$/.test(publisher)) fail("identity.publisher", "must be lowercase letters, digits and dashes")

  const scopes = (["app", "tools"] as const).map((scope) => {
    const list = allow[scope]
    if (!Array.isArray(list)) fail(`allow.${scope}`, "must be an array")
    return list.map((item, index) => {
      try {
        return entry(item)
      } catch (err) {
        return fail(`allow.${scope}[${index}]`, (err as Error).message)
      }
    })
  })

  const providers = search.providers
  if (!Array.isArray(providers)) fail("websearch.providers", "must be an array")

  return {
    identity: { publisher, name, displayName: text(identity.displayName, "identity.displayName") },
    provider: {
      id: text(provider.id, "provider.id"),
      name: text(provider.name, "provider.name"),
      baseURL: text(provider.baseURL, "provider.baseURL"),
      models: Object.fromEntries(
        Object.entries(models).map(([id, model]) => {
          const item = object(model, `provider.models.${id}`)
          const limit = item.limit === undefined ? undefined : object(item.limit, `provider.models.${id}.limit`)
          return [
            id,
            {
              name: text(item.name, `provider.models.${id}.name`),
              ...(limit && { limit: { context: Number(limit.context), output: Number(limit.output) } }),
            },
          ]
        }),
      ),
    },
    allow: { app: scopes[0], tools: scopes[1] },
    features: {
      autocomplete: bool(features.autocomplete, "features.autocomplete"),
      speechToText: bool(features.speechToText, "features.speechToText"),
      imageGeneration: bool(features.imageGeneration, "features.imageGeneration"),
      externalLinks: bool(features.externalLinks, "features.externalLinks"),
    },
    websearch: {
      providers: providers.map((item, index) => pick(item, `websearch.providers[${index}]`, ["exa", "parallel"] as const)),
      permission: pick(search.permission, "websearch.permission", ["ask", "allow", "deny"] as const),
      audit: bool(search.audit, "websearch.audit"),
    },
    webfetch: pick(root.webfetch, "webfetch", ["off", "tools"] as const),
    sandbox: bool(root.sandbox, "sandbox"),
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
