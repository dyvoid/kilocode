#!/usr/bin/env bun
/**
 * CI canary (R7): every hostname that appears in runtime source must be listed in reviewed-hosts.txt.
 * A new URL literal or hostname, typically arriving with an upstream sync, fails the build until
 * someone reviews it and adds it to the file (with a note on whether the build can reach it).
 *
 * Usage:
 *   bun script/canary.ts            check; exit 1 on unreviewed hosts
 *   bun script/canary.ts --update   rewrite reviewed-hosts.txt, keeping existing notes
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..", "..", "..")
const list = path.join(import.meta.dir, "..", "reviewed-hosts.txt")

/**
 * Packages that do not ship in the CLI binary or the VSIX, with the reason. Every other package's src/
 * is scanned, so a package added upstream is covered until someone decides otherwise.
 */
export const EXCLUDED: Record<string, string> = {
  "kilo-jetbrains": "separate product, not part of this build",
  "kilo-console": "web console, not shipped",
  "kilo-web-ui": "web app, not shipped",
  "kilo-i18n": "translated UI strings; links in them go through the link policy",
  "httpapi-codegen": "build-time code generator",
  script: "build and release scripts",
  client: "standalone client package, not bundled",
  "sdk-next": "unreleased SDK, not bundled",
}

/** Runtime source shipped in the CLI binary or the VSIX. */
export const SCOPE = [
  ...readdirSync(path.join(root, "packages"))
    .filter((name) => !(name in EXCLUDED) && statSync(path.join(root, "packages", name, "src"), { throwIfNoEntry: false })?.isDirectory())
    .map((name) => `packages/${name}/src`),
  "packages/sdk/js/src",
  "packages/kilo-vscode/webview-ui",
]

const SKIP_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "i18n", "stories", "dist", "out", "fixtures"])
const SKIP_FILE = /\.(test|spec|stories)\.[jt]sx?$/
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json)$/

// URL literals (also with credentials, JSON-escaped slashes, or templated labels such as
// `https://bedrock-runtime.${region}.amazonaws.com`: the labels after the last templated one are kept),
// plus quoted bare hostnames such as "api.kilo.ai" or "api.kilo.ai:443" that code concatenates into URLs.
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
const PART = "(?:[a-z0-9-]|\\$\\{[^}]*\\})+"
const LINK = new RegExp(
  `\\b(?:https?|wss?):(?:\\/\\/|\\\\/\\\\/)(?:[^@\\s"'\`/?#]+@)?(${PART}(?:\\.${PART})+)`,
  "gi",
)

/**
 * The fixed part of a possibly templated host: labels after the last `${...}`, if at least two. A
 * template at the very end (`host.com${path}`) is the path, not part of the host. Dots inside a
 * template (`${cfg.host}`) do not split labels.
 */
function fixed(host: string) {
  const labels = host
    .replace(/\$\{[^}]*\}/g, "\u0001")
    .replace(/\u0001+$/, "")
    .split(".")
    .map((item) => item.replaceAll("\u0001", "${}"))
  const last = labels.findLastIndex((item) => item.includes("${"))
  const rest = labels.slice(last + 1)
  return rest.length >= 2 && rest.every((item) => new RegExp(`^${LABEL}$`, "i").test(item)) ? rest.join(".") : undefined
}
const TLDS = "com|net|org|io|ai|dev|app|sh|co|cloud|xyz|run|so|gg|tech|me|tv|uk|de|fr|eu|us|ca|cn|jp|biz"
const BARE = new RegExp(`["'\`]((?:${LABEL}\\.)+(?:${TLDS}))(?=["'\`:/])`, "gi")

function walk(dir: string): string[] {
  const full = path.join(root, dir)
  const stat = statSync(full, { throwIfNoEntry: false })
  if (!stat) return []
  if (stat.isFile()) return [dir]
  return readdirSync(full).flatMap((item) => {
    if (SKIP_DIRS.has(item)) return []
    const rel = path.join(dir, item)
    const child = statSync(path.join(root, rel))
    if (child.isDirectory()) return walk(rel)
    return EXTENSIONS.test(item) && !SKIP_FILE.test(item) ? [rel] : []
  })
}

/** Map of hostname -> first few files that mention it. */
export function scan(dirs = SCOPE) {
  const found = new Map<string, string[]>()
  for (const file of dirs.flatMap(walk)) {
    const text = readFileSync(path.join(root, file), "utf8")
    for (const pattern of [LINK, BARE])
      for (const match of text.matchAll(pattern)) {
        const host = fixed(match[1].toLowerCase())
        if (!host) continue
        const files = found.get(host) ?? []
        if (!files.includes(file) && files.length < 3) files.push(file)
        found.set(host, files)
      }
  }
  return found
}

/** Runtime APIs the guard cannot wrap (read-only in Bun). Runtime source must not call them. */
const UNGUARDED = /\bBun\s*(?:\.\s*fetch\b|\[\s*["'`]fetch["'`]\s*\])/

/** Files in runtime source that call an API the guard cannot wrap. */
export function unguarded(dirs = SCOPE) {
  // The guard itself names it in comments.
  return dirs.filter((dir) => dir !== "packages/kilo-hardening/src").flatMap(walk).filter((file) => UNGUARDED.test(readFileSync(path.join(root, file), "utf8")))
}

/** reviewed-hosts.txt: one host per line, optional "# note" after it; blank lines and comments ignored. */
export function reviewed(text: string) {
  const out = new Map<string, string>()
  for (const line of text.split("\n")) {
    const value = line.trim()
    if (!value || value.startsWith("#")) continue
    const [host, ...note] = value.split("#")
    out.set(host.trim().toLowerCase(), note.join("#").trim())
  }
  return out
}

/** Hosts found in source that the reviewed list does not cover. */
export function unreviewed(found: Map<string, string[]>, known: Map<string, string>) {
  return [...found].filter(([host]) => !known.has(host))
}

if (import.meta.main) {
  const found = scan()
  const known = reviewed(readFileSync(list, { encoding: "utf8", flag: "a+" }))
  if (process.argv.includes("--update")) {
    const header = readFileSync(list, "utf8").split("\n").filter((line) => line.startsWith("#")).join("\n")
    const lines = [...found.keys()].sort().map((host) => {
      const note = known.get(host)
      return note ? `${host}  # ${note}` : host
    })
    writeFileSync(list, `${header}\n${lines.join("\n")}\n`)
    console.log(`reviewed-hosts.txt: ${lines.length} hosts`)
    process.exit(0)
  }
  const unwrapped = unguarded()
  if (unwrapped.length > 0) {
    console.error(`canary: Bun.fetch cannot be guarded; use fetch instead in:\n  ${unwrapped.join("\n  ")}`)
    process.exit(1)
  }
  const unknown = unreviewed(found, known)
  if (unknown.length === 0) {
    console.log(`canary: ${found.size} hosts in runtime source, all reviewed`)
    process.exit(0)
  }
  console.error(`canary: ${unknown.length} host(s) in runtime source are not in packages/kilo-hardening/reviewed-hosts.txt:\n`)
  for (const [host, files] of unknown) console.error(`  ${host}\n    ${files.join("\n    ")}`)
  console.error(
    "\nReview each host: can the restricted build reach it (gated, guarded, allowlisted)? Then add it to\n" +
      "reviewed-hosts.txt with a short note, or run `bun script/canary.ts --update` and annotate.",
  )
  process.exit(1)
}
