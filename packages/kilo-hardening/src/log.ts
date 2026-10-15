import { appendFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { config } from "./config"

export interface Denial {
  time: string
  pid: number
  scope: string
  host: string
  via: string
}

const seen: Denial[] = []

/**
 * Data directory of this build, matching the CLI's global data path (`$XDG_DATA_HOME/<identity.name>`).
 * KILO_HARDENING_LOG overrides only the log file location, never what is allowed.
 */
export function file() {
  const custom = process.env.KILO_HARDENING_LOG
  if (custom) return custom
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, config.identity.name, "log", "egress-denied.log")
}

/** Records a denied attempt in memory and as one JSON line in the local log. Never throws. */
export function record(input: Omit<Denial, "time" | "pid">) {
  const item = { time: new Date().toISOString(), pid: process.pid, ...input }
  seen.push(item)
  if (seen.length > 1000) seen.shift()
  const target = file()
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    appendFileSync(target, `${JSON.stringify(item)}\n`)
  } catch (err) {
    // Logging must never turn a denial into a different failure; report and move on.
    console.error(`[hardening] could not write ${target}:`, err)
  }
  return item
}

/** Denials recorded in this process (newest last). */
export function denials(): readonly Denial[] {
  return seen
}
