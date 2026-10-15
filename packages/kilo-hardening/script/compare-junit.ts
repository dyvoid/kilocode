#!/usr/bin/env bun
/**
 * Compares JUnit reports from the fork against reports from the upstream base tag, run on the same
 * runner image (acceptance criterion: existing upstream test suites pass). A test that passes upstream
 * and here fails, errors, is skipped or does not report at all is a regression unless
 * expected-test-differences.txt lists it with a reason. Tests that fail upstream too (environment,
 * flakiness) are reported, not counted.
 *
 * Test ids are "<package>:<file> > <describe> > <name>". The package comes from the report's file name
 * ("packages_opencode__junit.xml", as the workflow collects them), so equal file names in different
 * packages stay apart.
 *
 * Usage: bun script/compare-junit.ts <fork-reports-dir> <upstream-reports-dir> [--shards <n>]
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

type Outcome = "pass" | "fail" | "skip"

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((item) => {
    const full = path.join(dir, item)
    if (statSync(full).isDirectory()) return files(full)
    return item.endsWith(".xml") ? [full] : []
  })
}

function decode(text: string) {
  return text.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
}

const rank: Record<Outcome, number> = { pass: 0, skip: 1, fail: 2 }

function attr(attrs: string, name: string) {
  return decode(new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "")
}

/** Test id -> outcome. A test seen several times keeps its worst outcome. */
export function outcomes(xml: string, into = new Map<string, Outcome>(), pkg = "") {
  const cases = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  for (const match of xml.matchAll(cases)) {
    const attrs = match[1]
    const body = match[3] ?? ""
    const outcome: Outcome = /<(failure|error)\b/.test(body) ? "fail" : /<skipped\b/.test(body) ? "skip" : "pass"
    const parts = [attr(attrs, "file"), attr(attrs, "classname"), attr(attrs, "name")].filter(Boolean)
    // Names can embed temp paths with pids (/tmp/opencode-test-data-13950/...): digit runs that follow a
    // path or name separator are normalised so the same test matches across runs. "year 2024" is kept.
    const id = `${pkg ? `${pkg}:` : ""}${parts.join(" > ")}`.replace(/(?<=[-_/.])\d{4,}/g, "#")
    const seen = into.get(id)
    if (seen === undefined || rank[outcome] > rank[seen]) into.set(id, outcome)
  }
  return into
}

export function load(dir: string) {
  const out = new Map<string, Outcome>()
  for (const file of files(dir)) {
    const name = path.basename(file)
    outcomes(readFileSync(file, "utf8"), out, name.includes("__") ? name.slice(0, name.indexOf("__")) : "")
  }
  return out
}

/**
 * expected-test-differences.txt: upstream tests whose failure in the fork is an intended consequence of
 * the restricted build, one test id per line with a "# reason". Lines starting with # are comments.
 */
export function expected(text: string) {
  return new Set(
    text
      .split("\n")
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      // The reason follows the last " # ": ids can contain "#" where digits were normalised.
      .map((line) => (line.includes(" # ") ? line.slice(0, line.lastIndexOf(" # ")) : line).trim()),
  )
}

export function compare(fork: Map<string, Outcome>, upstream: Map<string, Outcome>, allowed = new Set<string>()) {
  const passed = [...upstream].filter(([, outcome]) => outcome === "pass").map(([id]) => id)
  // Same runner image on both sides, so a test that runs upstream and is skipped here is a regression too.
  const broken = passed.filter((id) => fork.get(id) === "fail" || fork.get(id) === "skip")
  // A test that passes upstream and never reports in the fork usually means its file crashed or was skipped.
  const missing = passed.filter((id) => !fork.has(id))
  const regressions = [...broken, ...missing].filter((id) => !allowed.has(id))
  const intended = [...broken, ...missing].filter((id) => allowed.has(id))
  const shared = [...fork].filter(([id, outcome]) => outcome === "fail" && upstream.get(id) === "fail").map(([id]) => id)
  const added = [...fork].filter(([id, outcome]) => outcome === "fail" && !upstream.has(id)).map(([id]) => id)
  return { regressions, missing, intended, shared, added }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const [forkDir, upstreamDir] = args.filter((item, index) => !item.startsWith("--") && args[index - 1] !== "--shards")
  if (!forkDir || !upstreamDir)
    throw new Error("usage: bun script/compare-junit.ts <fork-reports-dir> <upstream-reports-dir> [--shards <n>]")
  // Each side must have every shard's reports: a lost shard would shrink the "passes upstream" set.
  const shards = args.includes("--shards") ? Number(args[args.indexOf("--shards") + 1]) : undefined
  for (const dir of [forkDir, upstreamDir]) {
    const found = readdirSync(dir).filter((item) => statSync(path.join(dir, item)).isDirectory())
    if (shards !== undefined && found.length !== shards)
      throw new Error(`${dir}: expected ${shards} shard report directories, found ${found.length}`)
    // A shard whose reports are empty or truncated would shrink one side's test set without notice.
    for (const shard of found)
      if (load(path.join(dir, shard)).size === 0) throw new Error(`${dir}/${shard}: no test results in the shard's reports`)
  }
  const fork = load(forkDir)
  const upstream = load(upstreamDir)
  if (fork.size === 0 || upstream.size === 0) throw new Error(`no test results (fork ${fork.size}, upstream ${upstream.size})`)
  const allowed = expected(readFileSync(path.join(import.meta.dir, "..", "expected-test-differences.txt"), "utf8"))
  const result = compare(fork, upstream, allowed)
  console.log(`intended differences (expected-test-differences.txt): ${result.intended.length}`)
  for (const id of result.intended) console.log(`  ~ ${id}`)
  console.log(`pass upstream, missing in fork: ${result.missing.length}`)
  for (const id of result.missing) console.log(`  ? ${id}`)
  console.log(`fork: ${fork.size} tests, upstream: ${upstream.size} tests`)
  console.log(`failing on both (not counted): ${result.shared.length}`)
  for (const id of result.shared) console.log(`  = ${id}`)
  console.log(`failing, fork-only tests: ${result.added.length}`)
  for (const id of result.added) console.log(`  + ${id}`)
  if (result.regressions.length === 0) {
    console.log("no regressions: every upstream test that passes upstream passes in the fork")
    process.exit(0)
  }
  console.error(`REGRESSIONS (pass upstream, fail in fork): ${result.regressions.length}`)
  for (const id of result.regressions) console.error(`  ! ${id}`)
  process.exit(1)
}
