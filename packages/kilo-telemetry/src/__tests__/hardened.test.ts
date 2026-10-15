import { describe, expect, test } from "bun:test"
import { join } from "node:path"

describe("restricted-egress build", () => {
  test("telemetry stays off after setEnabled(true) and sends nothing", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "hardened.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    const line = out.trim().split("\n").at(-1)
    if (!line) throw new Error(err)
    expect(JSON.parse(line)).toEqual({ client: true, enabled: false, fetches: 0 })
  }, 30_000)
})
