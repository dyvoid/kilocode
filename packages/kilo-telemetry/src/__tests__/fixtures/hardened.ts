// Runs in its own process: hardening activation is process-global.
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hardening } from "@kilocode/kilo-hardening"
import { Client } from "../../client.js"
import { TelemetryEvent } from "../../events.js"
import { Telemetry } from "../../telemetry.js"

let calls = 0
const real = globalThis.fetch
globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
  calls++
  return real(...args)
}, real)

Hardening.activate()
process.env.KILO_TELEMETRY_LEVEL = "all"
await Telemetry.init({ dataPath: await mkdtemp(join(tmpdir(), "telemetry-hardened-")), version: "test", enabled: true })
// What the extension does on every connect when VS Code telemetry is on, and what /telemetry/setEnabled runs.
Telemetry.setEnabled(true)
Telemetry.track(TelemetryEvent.CLI_START)
Client.flushInBackground(0)
await new Promise((done) => setTimeout(done, 200))
await Telemetry.shutdown()

console.log(JSON.stringify({ client: Client.getClient() === null, enabled: Telemetry.isEnabled(), fetches: calls }))
process.exit(0)
