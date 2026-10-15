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

/** Runtime source shipped in the CLI binary or the VSIX. Out-of-scope packages are not listed. */
export const SCOPE = [
  "packages/opencode/src",
  "packages/core/src",
  "packages/kilo-gateway/src",
  "packages/kilo-telemetry/src",
  "packages/kilo-indexing/src",
  "packages/kilo-memory/src",
  "packages/kilo-sandbox/src",
  "packages/kilo-hardening/src",
  "packages/llm/src",
  "packages/codemode/src",
  "packages/server/src",
  "packages/protocol/src",
  "packages/plugin/src",
  "packages/plugin-atomic-chat/src",
  "packages/sdk/js/src",
  "packages/tui/src",
  "packages/kilo-vscode/src",
  "packages/kilo-vscode/webview-ui",
  "packages/kilo-ui/src",
  "packages/ui/src",
  "packages/session-ui/src",
]

const SKIP_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "i18n", "stories", "dist", "out", "fixtures"])
const SKIP_FILE = /\.(test|spec|stories)\.[jt]sx?$/
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json)$/

// URL literals, plus quoted bare hostnames such as "api.kilo.ai" that code concatenates into URLs.
const LINK = /\b(?:https?|wss?):\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi
const BARE = /["'`]((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|ai|dev|app|sh|co|cloud|xyz|run|so|gg|tech))["'`]/gi

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
        const host = match[1].toLowerCase()
        const files = found.get(host) ?? []
        if (!files.includes(file) && files.length < 3) files.push(file)
        found.set(host, files)
      }
  }
  return found
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
