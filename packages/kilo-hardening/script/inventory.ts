#!/usr/bin/env bun
/**
 * Regenerates the patch inventory in docs/HARDENING.md from git: one row per [hardened] commit with the
 * upstream files it edits (files that exist in the upstream base tag). New files are not listed.
 *
 * Usage: bun script/inventory.ts [--check]   (--check exits 1 when the committed table is stale)
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { baseTag, ensureTag, patches, root, upstreamFiles } from "./git"

const doc = path.join(root, "docs", "HARDENING.md")
const START = "<!-- inventory:start -->"
const END = "<!-- inventory:end -->"

export function table() {
  const base = ensureTag(baseTag())
  // Commit hashes change on every sync, so the table keys rows by subject and lists files only.
  // Patches that only add new files are left out: they cannot conflict with upstream.
  const rows = patches(base)
    .map((item) => ({ item, files: upstreamFiles(item.sha, base) }))
    .filter((row) => row.files.length > 0)
    .map((row) => {
      const subject = row.item.subject.replace(/^\[hardened\]\s*/, "").replaceAll("|", "\\|")
      return `| ${subject} | ${row.files.map((file) => `\`${file}\``).join("<br>")} |`
    })
  return ["| Patch | Upstream files edited |", "|---|---|", ...rows].join("\n")
}

if (import.meta.main) {
  const text = readFileSync(doc, "utf8")
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start < 0 || end < 0) throw new Error(`docs/HARDENING.md needs ${START} and ${END} markers`)
  const next = `${text.slice(0, start + START.length)}\n${table()}\n${text.slice(end)}`
  if (process.argv.includes("--check")) {
    if (next !== text) {
      console.error("docs/HARDENING.md patch inventory is stale: run `bun packages/kilo-hardening/script/inventory.ts`")
      process.exit(1)
    }
    process.exit(0)
  }
  writeFileSync(doc, next)
  console.log("docs/HARDENING.md inventory updated")
}
