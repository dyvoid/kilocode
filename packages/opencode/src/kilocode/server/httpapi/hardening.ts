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
] as const

/** Gateway routes kept behind build features so they can be switched back on. */
const FEATURES: Record<string, Parameters<typeof Hardening.feature>[0]> = {
  "/kilo/fim": "autocomplete",
  "/kilo/audio/transcriptions": "speechToText",
  "/kilo/models/transcriptions": "speechToText",
  "/kilo/models/images": "imageGeneration",
}

/** True when the restricted build must not serve this path. */
export function blocked(path: string) {
  if (!Hardening.off()) return false
  const feature = Object.entries(FEATURES).find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))
  if (feature) return !Hardening.feature(feature[1])
  const value = path.endsWith("/") ? path : `${path}/`
  return BLOCKED.some((prefix) => value.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
}

export const hardeningLayer = HttpRouter.middleware(
  Effect.succeed((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, "http://localhost").pathname
      if (!blocked(path)) return yield* effect
      return HttpServerResponse.jsonUnsafe(
        { name: "NotAvailable", data: { message: "This feature is not available in this build." } },
        { status: 404 },
      )
    }),
  ),
  { global: true },
)
