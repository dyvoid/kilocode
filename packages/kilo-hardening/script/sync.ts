#!/usr/bin/env bun
/**
 * Replays the [hardened] patch stack onto a new upstream tag and reports conflicts per patch (R6).
 *
 * Usage:
 *   bun script/sync.ts <tag> [--branch <name>] [--report <file>] [--stop]
 *   <tag> is an upstream tag (v7.8.13); an upstream branch name (main) also works for rehearsals.
 *
 * Creates <name> (default hardened/sync-<tag>) at the upstream tag and cherry-picks every commit from
 * the current base (packages/kilo-hardening/UPSTREAM) up to HEAD, oldest first.
 *   default  a patch that conflicts is recorded and skipped, so one run reports every conflict
 *   --stop   stop at the first conflict and leave it in the working tree to resolve by hand
 *            (then `git cherry-pick --continue` and rerun with the same branch to resume)
 * The working tree must be clean. Your original branch is checked out again at the end unless --stop
 * leaves a conflict in progress.
 */
import { writeFileSync } from "node:fs"
import { baseTag, ensureTag, git, patches, root } from "./git"

type Result = { sha: string; subject: string; status: "applied" | "empty" | "conflict" | "already"; files: string[] }

const args = process.argv.slice(2)
const values = new Set(["--branch", "--report"].map((name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)))
const tag = args.find((item) => !item.startsWith("--") && !values.has(item))
if (!tag) throw new Error("usage: bun script/sync.ts <tag> [--branch <name>] [--report <file>] [--stop]")
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const branch = option("--branch") ?? `hardened/sync-${tag.replaceAll("/", "-")}`
const report = option("--report")
const stop = args.includes("--stop")

if (git(["status", "--porcelain", "--untracked-files=no"]).out) throw new Error("working tree has uncommitted changes")
const original = git(["rev-parse", "--abbrev-ref", "HEAD"]).out
const base = ensureTag(baseTag())
const target = ensureTag(tag)
const stack = patches(base)
const resuming = git(["rev-parse", "--verify", "--quiet", branch], { check: false }).ok
if (!resuming) git(["branch", branch, target])
git(["checkout", "-q", branch])

// When resuming, skip patches whose subject is already on the sync branch.
const done = new Set(patches(target, branch).map((item) => item.subject))
const results: Result[] = []
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
  if (/nothing to commit|empty/i.test(pick.err + pick.out)) {
    git(["cherry-pick", "--skip"], { check: false })
    results.push({ ...item, status: "empty", files: [] })
    continue
  }
  const files = git(["diff", "--name-only", "--diff-filter=U"], { check: false }).out.split("\n").filter(Boolean)
  results.push({ ...item, status: "conflict", files })
  if (stop) break
  git(["cherry-pick", "--abort"], { check: false })
}

const conflicts = results.filter((item) => item.status === "conflict")
const lines = [
  `# Sync report: ${baseTag()} -> ${tag}`,
  "",
  `Branch \`${branch}\` at upstream \`${tag}\`; ${stack.length} patches from \`${baseTag()}\`.`,
  "",
  "| Status | Commit | Patch | Conflicting files |",
  "|---|---|---|---|",
  ...results.map(
    (item) => `| ${item.status} | ${item.sha.slice(0, 9)} | ${item.subject.replaceAll("|", "\\|")} | ${item.files.join("<br>")} |`,
  ),
  "",
  conflicts.length === 0
    ? "No conflicts. Run the checks (canary, hardening tests, egress test), regenerate bun.lock with `bun install`, update packages/kilo-hardening/UPSTREAM, then fast-forward the main branch."
    : `${conflicts.length} patch(es) conflicted${stop ? " (stopped at the first one)" : " and were skipped"}. ` +
      "bun.lock conflicts resolve by taking upstream's file and running `bun install`; source conflicts by re-applying the patch's intent on the new upstream code.",
]
const text = lines.join("\n") + "\n"
console.log(text)
if (report) writeFileSync(report.startsWith("/") ? report : `${root}/${report}`, text)

const pending = stop && conflicts.length > 0
if (!pending) git(["checkout", "-q", original])
process.exit(conflicts.length > 0 ? 1 : 0)
