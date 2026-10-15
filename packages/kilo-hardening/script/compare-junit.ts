#!/usr/bin/env bun
/**
 * Compares JUnit reports from the fork against reports from the upstream base tag, run on the same
 * runner image (acceptance criterion: existing upstream test suites pass). A test that fails or errors
 * here, or does not report at all, but passes upstream is a regression unless expected-test-differences.txt
 * lists it with a reason. Tests that fail upstream too (environment, flakiness) are reported, not counted.
 *
 * Usage: bun script/compare-junit.ts <fork-reports-dir> <upstream-reports-dir>
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

/** Test id ("<suite file> > <name>") -> outcome. A test seen several times keeps its worst outcome. */
export function outcomes(xml: string, into = new Map<string, Outcome>()) {
  const cases = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  for (const match of xml.matchAll(cases)) {
    const attrs = match[1]
    const name = decode(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "")
    const suite = decode(/\b(?:file|classname)="([^"]*)"/.exec(attrs)?.[1] ?? "")
    const body = match[3] ?? ""
    const outcome: Outcome = /<(failure|error)\b/.test(body) ? "fail" : /<skipped\b/.test(body) ? "skip" : "pass"
    // Names can embed temp paths with pids or timestamps (/tmp/opencode-test-data-13950/...); long digit
    // runs are normalised so the same test matches across runs.
    const id = `${suite} > ${name}`.replace(/\d{4,}/g, "#")
    if (into.get(id) !== "fail") into.set(id, outcome)
  }
  return into
}

export function load(dir: string) {
  const out = new Map<string, Outcome>()
  for (const file of files(dir)) outcomes(readFileSync(file, "utf8"), out)
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
      .map((line) => line.split(/\s+#\s/)[0].trim()),
  )
}

export function compare(fork: Map<string, Outcome>, upstream: Map<string, Outcome>, allowed = new Set<string>()) {
  const passed = [...upstream].filter(([, outcome]) => outcome === "pass").map(([id]) => id)
  const broken = passed.filter((id) => fork.get(id) === "fail")
  // A test that passes upstream and never reports in the fork usually means its file crashed or was skipped.
  const missing = passed.filter((id) => !fork.has(id))
  const regressions = [...broken, ...missing].filter((id) => !allowed.has(id))
  const intended = [...broken, ...missing].filter((id) => allowed.has(id))
  const shared = [...fork].filter(([id, outcome]) => outcome === "fail" && upstream.get(id) === "fail").map(([id]) => id)
  const added = [...fork].filter(([id, outcome]) => outcome === "fail" && !upstream.has(id)).map(([id]) => id)
  return { regressions, missing, intended, shared, added }
}

if (import.meta.main) {
  const [forkDir, upstreamDir] = process.argv.slice(2)
  if (!forkDir || !upstreamDir) throw new Error("usage: bun script/compare-junit.ts <fork-reports-dir> <upstream-reports-dir>")
  const fork = load(forkDir)
  const upstream = load(upstreamDir)
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
