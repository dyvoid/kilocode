import { describe as group, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { reviewed, scan, unreviewed } from "../script/canary"

const fixture = "packages/kilo-hardening/test/fixture/canary"

group("canary", () => {
  test("a new URL literal or hostname fails until it is reviewed", () => {
    const found = scan([fixture])
    expect([...found.keys()].sort()).toEqual(["beacon.example.io", "new-telemetry.example.net"])
    expect(unreviewed(found, reviewed("# header\n")).map(([host]) => host).sort()).toEqual([
      "beacon.example.io",
      "new-telemetry.example.net",
    ])
    const list = reviewed("new-telemetry.example.net  # reviewed: blocked by the guard\nbeacon.example.io\n")
    expect(unreviewed(found, list)).toEqual([])
  })

  test("the committed list covers all runtime source", () => {
    const text = readFileSync(path.join(import.meta.dir, "..", "reviewed-hosts.txt"), "utf8")
    expect(unreviewed(scan(), reviewed(text))).toEqual([])
  })
})
