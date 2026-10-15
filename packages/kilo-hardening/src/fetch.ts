import type { Scope } from "./config"
import { loopback } from "./match"
import { deny, permitUrl, permitUrlAsync } from "./policy"

type Fetch = typeof globalThis.fetch

export interface FetchOptions {
  scope: Scope
  /** Allowlist proxy to route non-loopback requests through (Bun only; ignored when undefined). */
  proxy?: string
  /**
   * A proxy from HTTP(S)_PROXY outside the allowlist. Bun reads those variables once at startup and has
   * no per-request way to go direct, so requests it would carry are refused instead.
   */
  stray?: string
}

/**
 * A RequestInit key that narrows one request (and its redirects) to a scope, for callers inside a
 * wider-scoped process: web fetch runs in the CLI (cli scope) but may only reach tools hosts.
 */
export const SCOPE = Symbol.for("kilo.hardening.scope")

const MAX_REDIRECTS = 20
const REDIRECTS = [301, 302, 303, 307, 308]

function target(input: RequestInfo | URL) {
  if (input instanceof URL) return input
  if (typeof input === "string") return new URL(input)
  return new URL(input.url)
}

/** The parts of a Request needed to replay it on each redirect hop. Its body can be read only once. */
async function unpack(request: Request): Promise<RequestInit> {
  const empty = request.method === "GET" || request.method === "HEAD" || !request.body
  return {
    method: request.method,
    headers: request.headers,
    body: empty ? undefined : await request.arrayBuffer(),
    signal: request.signal,
    credentials: request.credentials,
  }
}

/** Bun's `proxy` option is a URL string or `{ url, headers }`. */
function proxied(init?: RequestInit) {
  const value = (init as { proxy?: unknown } | undefined)?.proxy
  if (value == null) return undefined
  if (typeof value === "string") return value
  return String((value as { url?: unknown }).url)
}

function redirected(response: Response) {
  Object.defineProperty(response, "redirected", { value: true })
  return response
}

/**
 * Wraps a fetch implementation so every request, and every redirect hop, is checked against the
 * scope's allowlist before a connection is made. Redirects are followed here (manually) because the
 * runtime's internal redirect handling would otherwise reach hosts the wrapper never saw.
 */
export function wrapFetch(real: Fetch, opts: FetchOptions): Fetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const narrowed = (init as Record<symbol, unknown> | undefined)?.[SCOPE]
    const scope: Scope = narrowed === "tools" || narrowed === "app" ? narrowed : opts.scope
    // A proxy the caller picks is the actual network peer, so it must be allowed too.
    const custom = proxied(init)
    if (custom !== undefined) await permitUrlAsync(scope, custom, "fetch proxy")
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow")
    const route = (url: URL, next?: RequestInit) => {
      if (!opts.proxy || custom !== undefined || loopback(url.hostname) || !url.protocol.startsWith("http")) return next
      return { ...next, proxy: opts.proxy } as RequestInit
    }

    const check = async (url: URL) => {
      await permitUrlAsync(scope, url, "fetch")
      // Bun would send this through a proxy from the environment that is not allowed.
      if (opts.stray && !opts.proxy && custom === undefined && url.protocol.startsWith("http") && !loopback(url.hostname))
        deny(scope, new URL(opts.stray).hostname, "fetch proxy")
      return url
    }

    let url = await check(target(input))
    if (mode !== "follow") return real(input, route(url, init))

    let request: string | URL = input instanceof Request ? input.url : input
    let options: RequestInit = { ...(input instanceof Request ? await unpack(input) : undefined), ...init, redirect: "manual" }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response: Response = await real(request, route(url, options))
      const location = response.headers.get("location")
      if (!REDIRECTS.includes(response.status) || !location) return hop > 0 ? redirected(response) : response
      const next = new URL(location, url)
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        await response.body?.cancel()
        throw new TypeError(`fetch failed: redirect to a non-HTTP(S) URL (${next.protocol})`)
      }
      await check(next)
      // Per the fetch spec: 303 (except for GET/HEAD) and 301/302 after POST become a bodiless GET;
      // everything else keeps method and body.
      const verb = (options.method ?? "GET").toUpperCase()
      const downgrade: boolean =
        (response.status === 303 && verb !== "GET" && verb !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && verb === "POST")
      if (!downgrade && options.body instanceof ReadableStream)
        throw new TypeError("Cannot follow a redirect that resends a streamed request body")
      await response.body?.cancel()
      const headers = new Headers(options.headers)
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
        body: downgrade ? undefined : options.body,
        headers,
        redirect: "manual",
      }
      request = next
      url = next
    }
    throw new TypeError(`Too many redirects (more than ${MAX_REDIRECTS})`)
  }
  // Keep runtime extras, but Bun's fetch.preconnect opens a connection itself, so it is checked too.
  const out = Object.assign(guarded, real) as Fetch & { preconnect?: (url: string | URL, ...rest: unknown[]) => void }
  const pre = (real as { preconnect?: (url: string | URL, ...rest: unknown[]) => void }).preconnect
  if (typeof pre === "function")
    out.preconnect = (url: string | URL, ...rest: unknown[]) => {
      permitUrl(opts.scope, String(url), "fetch.preconnect")
      return pre.call(real, url, ...rest)
    }
  return out
}
