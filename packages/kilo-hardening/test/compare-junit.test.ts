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
  test("only tests that pass upstream and fail in the fork are regressions", () => {
    expect(fork.get("a.test.ts > skipped")).toBe("skip")
    expect(compare(fork, upstream)).toEqual({
      regressions: ["a.test.ts > broke", "c.test.ts > crashed"],
      missing: ["c.test.ts > crashed"],
      intended: [],
      shared: ["a.test.ts > env & flaky"],
      added: ["b.test.ts > new"],
    })
  })

  test("listed differences are reported as intended, not as regressions", () => {
    const allowed = expected("# header\na.test.ts > broke  # the build moves this file\n")
    const result = compare(fork, upstream, allowed)
    expect(result.regressions).toEqual(["c.test.ts > crashed"])
    expect(result.intended).toEqual(["a.test.ts > broke"])
  })

  test("temp paths with pids in test names still match across runs", () => {
    const a = outcomes(`<testcase classname="p" name="allows [/tmp/opencode-test-data-13950/config]"/>`)
    const b = outcomes(`<testcase classname="p" name="allows [/tmp/opencode-test-data-20417/config]"/>`)
    expect([...a.keys()]).toEqual([...b.keys()])
  })
})
