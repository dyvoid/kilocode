import { Hardening } from "@kilocode/kilo-hardening"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

/** Routes that would reach the Kilo cloud or a removed integration. Each entry is a path prefix. */
const BLOCKED = [
  "/kilo/", // Kilo gateway: auth, profile, organization, notifications, cloud sessions, modes, edit
  "/kilocode/marketplace",
  "/kilocode/provider-usage", // quota lookups against Codex/Copilot/gateway
  "/kilocode/anaconda-desktop", // local runtime discovery probes loopback ports
  "/remote/",
  "/indexing/models", // gateway embedding catalog
  "/experimental/console",
  "/global/upgrade", // downloads and runs an installer
] as const

/** Gateway routes kept behind build features so they can be switched back on. */
const FEATURES: Record<string, Parameters<typeof Hardening.feature>[0]> = {
  "/kilo/fim": "autocomplete",
  "/kilo/audio/transcriptions": "speechToText",
  "/kilo/models/transcriptions": "speechToText",
  "/kilo/models/images": "imageGeneration",
}

/** The path as the router matches it: percent-decoded, lower-case, repeated slashes collapsed. Undefined if malformed. */
function canonical(path: string) {
  const value = URL.canParse(`http://x${path}`) ? new URL(`http://x${path}`).pathname : undefined
  if (value === undefined) return undefined
  try {
    return decodeURIComponent(value).toLowerCase().replace(/\/{2,}/g, "/")
  } catch {
    // Malformed percent-encoding: refuse rather than guess how the router reads it.
    return undefined
  }
}

/**
 * The path part of a request URL as the server received it. Not `new URL(url, base)`: a request line of
 * "//kilo/profile" would parse as host "kilo" and path "/profile".
 */
export function requestPath(url: string) {
  if (!url.startsWith("/")) return URL.canParse(url) ? new URL(url).pathname : url
  return url.split(/[?#]/)[0]
}

/** True when the restricted build must not serve this request URL. */
export function blocked(url: string) {
  return Hardening.off() && refused(requestPath(url))
}

/** The path decision on its own, for tests: feature routes count as switched on outside a hardened process. */
export function refused(path: string) {
  const value = canonical(path)
  if (value === undefined) return true
  const feature = Object.entries(FEATURES).find(([prefix]) => value === prefix || value.startsWith(`${prefix}/`))
  if (feature) return !Hardening.feature(feature[1])
  const slashed = value.endsWith("/") ? value : `${value}/`
  return BLOCKED.some((prefix) => slashed.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
}

export const hardeningLayer = HttpRouter.middleware(
  Effect.succeed((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!blocked(request.url)) return yield* effect
      return HttpServerResponse.jsonUnsafe(
        { name: "NotAvailable", data: { message: "This feature is not available in this build." } },
        { status: 404 },
      )
    }),
  ),
  { global: true },
)
