import type { Scope } from "./config"
import { loopback } from "./match"
import { permitUrlAsync } from "./policy"

type Fetch = typeof globalThis.fetch

export interface FetchOptions {
  scope: Scope
  /** Allowlist proxy to route non-loopback requests through (Bun only; ignored when undefined). */
  proxy?: string
}

const MAX_REDIRECTS = 20

function target(input: RequestInfo | URL) {
  if (input instanceof URL) return input
  if (typeof input === "string") return new URL(input)
  return new URL(input.url)
}

function method(input: RequestInfo | URL, init?: RequestInit) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
}

/**
 * Wraps a fetch implementation so every request, and every redirect hop, is checked against the
 * scope's allowlist before a connection is made. Redirects are followed here (manually) because the
 * runtime's internal redirect handling would otherwise reach hosts the wrapper never saw.
 */
export function wrapFetch(real: Fetch, opts: FetchOptions): Fetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow")
    const route = (url: URL, next?: RequestInit) => {
      if (!opts.proxy || loopback(url.hostname) || !url.protocol.startsWith("http")) return next
      return { ...next, proxy: opts.proxy } as RequestInit
    }

    let url = await permitUrlAsync(opts.scope, target(input), "fetch")
    if (mode !== "follow") return real(input, route(url, init))

    let request: RequestInfo | URL = input
    let options: RequestInit | undefined = { ...init, redirect: "manual" }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response: Response = await real(request, route(url, options))
      const location = response.headers.get("location")
      if (response.status < 300 || response.status > 399 || response.status === 304 || !location) return response
      const next = await permitUrlAsync(opts.scope, new URL(location, url), "fetch redirect")
      // Per the fetch spec: 303, and 301/302 after POST, become a bodiless GET; 307/308 keep method and body.
      const verb = method(request, options)
      const downgrade: boolean = response.status === 303 || ((response.status === 301 || response.status === 302) && verb === "POST")
      const body = options?.body ?? (request instanceof Request ? request.body : undefined)
      if (!downgrade && body instanceof ReadableStream)
        throw new TypeError("Cannot follow a 307/308 redirect with a streamed request body")
      await response.body?.cancel()
      const headers = new Headers(options?.headers ?? (request instanceof Request ? request.headers : undefined))
      if (next.origin !== url.origin) {
        headers.delete("authorization")
        headers.delete("cookie")
        headers.delete("proxy-authorization")
      }
      if (downgrade) {
        headers.delete("content-type")
        headers.delete("content-length")
      }
      options = {
        ...options,
        method: downgrade ? "GET" : verb,
        body: downgrade ? undefined : (options?.body ?? undefined),
        headers,
        redirect: "manual",
      }
      request = next
      url = next
    }
    throw new TypeError(`Too many redirects (more than ${MAX_REDIRECTS})`)
  }
  // Keep runtime extras such as Bun's fetch.preconnect.
  return Object.assign(guarded, real) as Fetch
}
