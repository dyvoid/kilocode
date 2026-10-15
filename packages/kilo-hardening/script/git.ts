// Small git helpers shared by sync.ts and inventory.ts.
import { readFileSync } from "node:fs"
import path from "node:path"

export const root = path.join(import.meta.dir, "..", "..", "..")
export const UPSTREAM_URL = "https://github.com/Kilo-Org/kilocode"

/** The upstream tag the patch stack currently sits on (packages/kilo-hardening/UPSTREAM). */
export function baseTag() {
  return readFileSync(path.join(import.meta.dir, "..", "UPSTREAM"), "utf8").trim()
}

export function git(args: string[], opts: { check?: boolean } = {}) {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout.toString().trim()
  if (opts.check !== false && proc.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}):\n${proc.stderr.toString().trim()}`)
  return { ok: proc.exitCode === 0, out, err: proc.stderr.toString().trim() }
}

/**
 * Local ref for an upstream tag, fetched on demand: upstream-v7.8.12 for v7.8.12. A name that is not an
 * upstream tag is fetched as a branch (refetched every time, since branches move).
 */
export function ensureTag(tag: string, url = UPSTREAM_URL) {
  const ref = `upstream-${tag.replaceAll("/", "-")}`
  if (git(["rev-parse", "--verify", "--quiet", `refs/tags/${ref}`], { check: false }).ok) return ref
  if (git(["fetch", "--no-tags", url, `refs/tags/${tag}:refs/tags/${ref}`], { check: false }).ok) return ref
  git(["fetch", "--no-tags", "--force", url, `refs/heads/${tag}:refs/remotes/upstream/${tag}`])
  return `upstream/${tag}`
}

export type Patch = { sha: string; subject: string }

/** Commits on `head` since the upstream base, oldest first. */
export function patches(base: string, head = "HEAD"): Patch[] {
  const out = git(["log", "--reverse", "--format=%H%x09%s", `${base}..${head}`]).out
  if (!out) return []
  return out.split("\n").map((line) => {
    const [sha, ...rest] = line.split("\t")
    return { sha, subject: rest.join("\t") }
  })
}

/** Files a commit changes that already existed in the upstream base (i.e. edits to upstream files). */
export function upstreamFiles(sha: string, base: string) {
  const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).out.split("\n").filter(Boolean)
  return files.filter((file) => git(["cat-file", "-e", `${base}:${file}`], { check: false }).ok)
}
