#!/usr/bin/env bun
/**
 * Replays the [hardened] patch stack onto a new upstream tag and reports conflicts per patch (R6).
 *
 * Usage:
 *   bun script/sync.ts <tag> [--from <branch>] [--branch <name>] [--report <file>] [--stop]
 *   <tag> is an upstream tag (v7.8.13); an upstream branch name (main) also works for rehearsals.
 *
 * Creates <name> (default hardened/sync-<tag>) at the upstream tag and cherry-picks every [hardened]
 * commit (other commits are listed, not picked; merge commits are skipped, so keep fixes out of merges)
 * from the current base
 * (packages/kilo-hardening/UPSTREAM) up to <branch> (default: the current branch), oldest first.
 *   default  a patch that conflicts is recorded and skipped, so one run reports every conflict
 *   --stop   stop at the first conflict and leave it in the working tree to resolve by hand; after
 *            `git cherry-pick --continue`, rerun the same command (with --from <branch> if you are still
 *            on the sync branch) to resume
 * A conflict only in bun.lock keeps upstream's lockfile and applies the rest of the patch; regenerate it
 * with `bun install` after the sync. The working tree must be clean. The branch you ran it from is
 * checked out again at the end (the sync branch, when resuming from it) unless --stop leaves a conflict
 * in progress. --report paths are relative
 * to the current directory.
 */
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { baseTag, commits, ensureTag, git, PREFIX, root } from "./git"

type Result = {
  sha: string
  subject: string
  status: "applied" | "applied, bun.lock kept" | "empty" | "conflict" | "already" | "not picked"
  files: string[]
}

const args = process.argv.slice(2)
const named = ["--branch", "--report", "--from"]
const values = new Set(named.map((name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)))
const tag = args.find((item) => !item.startsWith("--") && !values.has(item))
const usage = "usage: bun script/sync.ts <tag> [--from <branch>] [--branch <name>] [--report <file>] [--stop]"
if (!tag) throw new Error(usage)
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const branch = option("--branch") ?? `hardened/sync-${tag.replaceAll("/", "-")}`
const report = option("--report") && path.resolve(process.cwd(), option("--report")!)
const stop = args.includes("--stop")

if (existsSync(path.resolve(root, git(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]).out)))
  throw new Error("a cherry-pick is in progress: finish it with `git cherry-pick --continue` (or --abort) first")
if (git(["status", "--porcelain", "--untracked-files=no"]).out) throw new Error("working tree has uncommitted changes")
const current = git(["rev-parse", "--abbrev-ref", "HEAD"]).out
// Detached HEAD: return to the same commit at the end.
const original = current === "HEAD" ? git(["rev-parse", "HEAD"]).out : current
const source = option("--from") ?? original
if (source === branch) throw new Error(`you are on the sync branch ${branch}; pass --from <your main branch> to resume`)
const base = ensureTag(baseTag())
const target = ensureTag(tag)
const all = commits(base, source)
const stack = all.filter((item) => item.subject.startsWith(PREFIX))
const resuming = git(["rev-parse", "--verify", "--quiet", branch], { check: false }).ok
if (!resuming) git(["branch", branch, target])
git(["checkout", "-q", branch])

const unmerged = () => git(["diff", "--name-only", "--diff-filter=U"], { check: false }).out.split("\n").filter(Boolean)

// When resuming, skip patches whose subject is already on the sync branch.
const done = new Set(commits(target, branch).map((item) => item.subject))
const results: Result[] = all
  .filter((item) => !item.subject.startsWith(PREFIX))
  .map((item) => ({ ...item, status: "not picked" as const, files: [] }))
for (const item of stack) {
  if (done.has(item.subject)) {
    results.push({ ...item, status: "already", files: [] })
    continue
  }
  const pick = git(["cherry-pick", "-x", item.sha], { check: false })
  if (pick.ok) {
    results.push({ ...item, status: "applied", files: [] })
    continue
  }
  const picking = () => existsSync(path.resolve(root, git(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]).out))
  const staged = () => !git(["diff", "--cached", "--quiet"], { check: false }).ok
  if (!picking()) throw new Error(`cherry-pick of ${item.sha} failed without stopping:\n${pick.err}`)
  const files = unmerged()
  // Empty: git stopped without conflicts and nothing is staged (the change is already upstream).
  if (files.length === 0 && !staged()) {
    git(["cherry-pick", "--skip"])
    results.push({ ...item, status: "empty", files: [] })
    continue
  }
  if (files.length === 1 && files[0] === "bun.lock") {
    git(["checkout", "--ours", "--", "bun.lock"])
    git(["add", "bun.lock"])
    // A patch that only touched bun.lock is empty once upstream's lockfile is kept.
    if (!staged()) {
      git(["cherry-pick", "--skip"])
      results.push({ ...item, status: "empty", files })
      continue
    }
    git(["-c", "core.editor=true", "cherry-pick", "--continue"])
    results.push({ ...item, status: "applied, bun.lock kept", files })
    continue
  }
  results.push({ ...item, status: "conflict", files })
  if (stop) break
  git(["cherry-pick", "--abort"], { check: false })
}

const conflicts = results.filter((item) => item.status === "conflict")
const lockfile = results.some((item) => item.status === "applied, bun.lock kept")
const lines = [
  `# Sync report: ${baseTag()} -> ${tag}`,
  "",
  `Branch \`${branch}\` at upstream \`${tag}\`; ${stack.length} patches from \`${baseTag()}\` on \`${source}\`.`,
  "",
  "| Status | Commit | Patch | Conflicting files |",
  "|---|---|---|---|",
  ...results.map(
    (item) => `| ${item.status} | ${item.sha.slice(0, 9)} | ${item.subject.replaceAll("|", "\\|")} | ${item.files.join("<br>")} |`,
  ),
  "",
  ...(results.some((item) => item.status === "not picked")
    ? ["Commits without the [hardened] prefix are not replayed (merge commits are skipped silently); re-create them as patches if they matter.", ""]
    : []),
  ...(lockfile ? ["Some patches kept upstream's bun.lock: run `bun install` and commit the lockfile.", ""] : []),
  conflicts.length === 0
    ? "No conflicts. Run the checks (canary, hardening tests, egress test), regenerate bun.lock with `bun install`, update packages/kilo-hardening/UPSTREAM, then fast-forward the main branch."
    : `${conflicts.length} patch(es) conflicted${stop ? " (stopped at the first one)" : " and were skipped"}. ` +
      "Re-apply each one's intent on the new upstream code.",
]
const text = lines.join("\n") + "\n"
console.log(text)
if (report) writeFileSync(report, text)

const pending = stop && conflicts.length > 0
if (!pending) git(["checkout", "-q", original])
process.exit(conflicts.length > 0 ? 1 : 0)
