import { describe as group, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { reviewed, scan, unreviewed } from "../script/canary"

const fixture = "packages/kilo-hardening/test/fixture/canary"

group("canary", () => {
  test("a new URL literal or hostname fails until it is reviewed", () => {
    const found = scan([fixture])
    expect([...found.keys()].sort()).toEqual([
      "bare.example.dev",
      "beacon.example.io",
      "creds.example.net",
      "env.example.net",
      "escaped.example.org",
      "later.example.com",
      "new-telemetry.example.net",
      "prop.example.com",
      "trail.example.com",
      "warehouse.example.com",
    ])
    expect(unreviewed(found, reviewed("# header\n")).length).toBe(10)
    const list = reviewed(
      "new-telemetry.example.net  # reviewed: blocked by the guard\nbeacon.example.io\nbare.example.dev\ncreds.example.net\nescaped.example.org\nwarehouse.example.com\nlater.example.com\nprop.example.com\ntrail.example.com\nenv.example.net\n",
    )
    expect(unreviewed(found, list)).toEqual([])
  })

  test("the committed list covers all runtime source", () => {
    const text = readFileSync(path.join(import.meta.dir, "..", "reviewed-hosts.txt"), "utf8")
    expect(unreviewed(scan(), reviewed(text))).toEqual([])
  })
})
