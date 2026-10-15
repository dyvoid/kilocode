import ipaddr from "ipaddr.js"

export type Entry =
  | { kind: "host"; host: string; ports?: number[] }
  | { kind: "suffix"; suffix: string; ports?: number[] }
  | { kind: "cidr"; range: [ipaddr.IPv4 | ipaddr.IPv6, number]; text: string; ports?: number[] }

/** Lowercase, strip IPv6 brackets and a trailing dot, so "LLM.Corp.Example." and "[::1]" compare cleanly. */
export function normalize(host: string) {
  const value = host.trim().toLowerCase().replace(/\.$/, "")
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1)
  return value
}

function ports(value: unknown) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((port) => !Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error("ports must be an array of integers between 1 and 65535")
  return value as number[]
}

/** Parses one allowlist entry: { host }, { suffix } or { cidr }, each with optional { ports }. */
export function entry(input: unknown): Entry {
  if (!input || typeof input !== "object") throw new Error("must be an object")
  const item = input as Record<string, unknown>
  const keys = ["host", "suffix", "cidr"].filter((key) => key in item)
  if (keys.length !== 1) throw new Error("must have exactly one of host, suffix, cidr")
  const allowed = ports(item.ports)
  if (typeof item.host === "string") {
    const host = normalize(item.host)
    if (!host || host.includes("/") || host.includes("*")) throw new Error(`invalid host ${JSON.stringify(item.host)}`)
    return { kind: "host", host, ports: allowed }
  }
  if (typeof item.suffix === "string") {
    const suffix = normalize(item.suffix).replace(/^\./, "")
    if (!suffix.includes(".") || suffix.includes("*")) throw new Error(`invalid suffix ${JSON.stringify(item.suffix)}`)
    return { kind: "suffix", suffix, ports: allowed }
  }
  if (typeof item.cidr === "string") {
    try {
      return { kind: "cidr", range: ipaddr.parseCIDR(item.cidr), text: item.cidr, ports: allowed }
    } catch {
      throw new Error(`invalid cidr ${JSON.stringify(item.cidr)}`)
    }
  }
  throw new Error("host, suffix and cidr must be strings")
}

function address(host: string) {
  if (!ipaddr.isValid(host)) return undefined
  const parsed = ipaddr.parse(host)
  // Treat IPv4-mapped IPv6 (::ffff:10.0.0.1) as the IPv4 address it carries.
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
    return (parsed as ipaddr.IPv6).toIPv4Address()
  return parsed
}

/** True for localhost, 127.0.0.0/8 and ::1. Always allowed, in every scope. */
export function loopback(host: string) {
  const value = normalize(host)
  // Only the literal name: "*.localhost" is not guaranteed to resolve to loopback on every resolver.
  if (value === "localhost") return true
  const ip = address(value)
  return ip !== undefined && ip.range() === "loopback"
}

function port(item: Entry, value: number | undefined) {
  if (!item.ports || value === undefined) return true
  return item.ports.includes(value)
}

function inside(item: Extract<Entry, { kind: "cidr" }>, ip: ipaddr.IPv4 | ipaddr.IPv6) {
  if (ip.kind() !== item.range[0].kind()) return false
  return ip.match(item.range)
}

/**
 * Decides a destination by name alone. Returns "allow", "deny", or "resolve" when only CIDR
 * entries could still allow it, in which case the caller must check the resolved addresses
 * with `allowsAddress` before connecting.
 */
export function check(list: readonly Entry[], host: string, target?: number): "allow" | "deny" | "resolve" {
  const value = normalize(host)
  if (loopback(value)) return "allow"
  const ip = address(value)
  for (const item of list) {
    if (!port(item, target)) continue
    if (item.kind === "host" && (item.host === value || (ip && address(item.host)?.toString() === ip.toString())))
      return "allow"
    if (item.kind === "suffix" && !ip && (value === item.suffix || value.endsWith(`.${item.suffix}`))) return "allow"
    if (item.kind === "cidr" && ip && inside(item, ip)) return "allow"
  }
  if (ip) return "deny"
  return list.some((item) => item.kind === "cidr" && port(item, target)) ? "resolve" : "deny"
}

/** Checks a resolved address against the CIDR entries (used after `check` returned "resolve"). */
export function allowsAddress(list: readonly Entry[], ip: string, target?: number) {
  if (loopback(ip)) return true
  const parsed = address(normalize(ip))
  if (!parsed) return false
  return list.some((item) => item.kind === "cidr" && port(item, target) && inside(item, parsed))
}

/** Default port for a URL, so port-restricted entries apply to "https://host/" as 443. */
export function urlPort(url: URL) {
  if (url.port) return Number(url.port)
  if (url.protocol === "https:" || url.protocol === "wss:") return 443
  if (url.protocol === "http:" || url.protocol === "ws:") return 80
  return undefined
}

/** Human-readable form of an entry for error messages and docs. */
export function describe(item: Entry) {
  const base = item.kind === "host" ? item.host : item.kind === "suffix" ? `*.${item.suffix}` : item.text
  return item.ports ? `${base}:${item.ports.join("|")}` : base
}
