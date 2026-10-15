import { describe as group, expect, test } from "bun:test"
import { compare, expected, outcomes } from "../script/compare-junit"

const fork = outcomes(`<testsuites><testsuite name="a.test.ts">
<testcase name="ok" classname="a.test.ts" time="0.1"/>
<testcase name="broke" classname="a.test.ts"><failure message="x">boom</failure></testcase>
<testcase name="env &amp; flaky" classname="a.test.ts"><error message="y"/></testcase>
<testcase name="new" classname="b.test.ts"><failure/></testcase>
<testcase name="skipped" classname="a.test.ts"><skipped/></testcase>
</testsuite></testsuites>`)
const upstream = outcomes(`<testsuites>
<testcase name="ok" classname="a.test.ts"/>
<testcase name="broke" classname="a.test.ts"/>
<testcase name="env &amp; flaky" classname="a.test.ts"><failure/></testcase>
<testcase name="skipped" classname="a.test.ts"/>
<testcase name="crashed" classname="c.test.ts"/>
</testsuites>`)

group("compare-junit", () => {
  test("only tests that pass upstream and fail, skip or vanish in the fork are regressions", () => {
    expect(fork.get("a.test.ts > skipped")).toBe("skip")
    expect(compare(fork, upstream)).toEqual({
      regressions: ["a.test.ts > broke", "a.test.ts > skipped", "c.test.ts > crashed"],
      missing: ["c.test.ts > crashed"],
      intended: [],
      shared: ["a.test.ts > env & flaky"],
      added: ["b.test.ts > new"],
    })
  })

  test("listed differences are reported as intended, not as regressions", () => {
    const allowed = expected("# header\na.test.ts > broke  # the build moves this file\n")
    const result = compare(fork, upstream, allowed)
    expect(result.regressions).toEqual(["a.test.ts > skipped", "c.test.ts > crashed"])
    expect(result.intended).toEqual(["a.test.ts > broke"])
  })

  test("temp paths with pids in test names still match across runs", () => {
    const a = outcomes(`<testcase classname="p" name="allows [/tmp/opencode-test-data-13950/config]"/>`)
    const b = outcomes(`<testcase classname="p" name="allows [/tmp/opencode-test-data-20417/config]"/>`)
    expect([...a.keys()]).toEqual([...b.keys()])
  })

  test("ids carry package, file and describe chain; Bun writes classname before file", () => {
    const xml = `<testcase name="t" classname="group" time="0" file="test/x.test.ts" line="3"/>`
    expect([...outcomes(xml, new Map(), "packages_opencode").keys()]).toEqual(["packages_opencode:test/x.test.ts > group > t"])
    expect([...outcomes(`<testcase name="t" classname="" file="test/x.test.ts"/>`).keys()]).toEqual(["test/x.test.ts > t"])
  })

  test("numbers that are part of a name are not merged", () => {
    const xml = `<testcase classname="dates" name="year 2024"/><testcase classname="dates" name="year 2025"><failure/></testcase>`
    expect(outcomes(xml).size).toBe(2)
  })

  test("a reason separator inside the id does not cut it", () => {
    expect([...expected("a > data-# case # # why\n")]).toEqual(["a > data-# case #"])
  })
})
