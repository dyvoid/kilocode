#!/usr/bin/env bun
/**
 * Build-time: puts ripgrep next to the CLI binary in the VSIX's bin/ so the restricted build never
 * downloads it at runtime (the CLI looks there when hardened, see core/src/ripgrep/binary.ts).
 * Each archive is checked against a SHA-256 pinned here (taken from ripgrep's release, 2026-10-15), so a
 * replaced release asset fails the build instead of shipping. Bumping VERSION means re-pinning every hash.
 *
 * Usage: bun script/ripgrep.ts <vsce-target> <bin-dir>
 */
import { $ } from "bun"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Keep in step with VERSION in packages/core/src/ripgrep/binary.ts.
export const VERSION = "15.1.0"

/** ripgrep release platform per VSIX target. alpine-arm64 has no musl build: it relies on a system rg. */
export const TARGETS: Record<string, { platform: string; extension: "tar.gz" | "zip"; sha256: string } | undefined> = {
  "linux-x64": {
    platform: "x86_64-unknown-linux-musl",
    extension: "tar.gz",
    sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
  },
  "linux-arm64": {
    platform: "aarch64-unknown-linux-gnu",
    extension: "tar.gz",
    sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
  },
  "alpine-x64": {
    platform: "x86_64-unknown-linux-musl",
    extension: "tar.gz",
    sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
  },
  "alpine-arm64": undefined,
  "darwin-x64": {
    platform: "x86_64-apple-darwin",
    extension: "tar.gz",
    sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
  },
  "darwin-arm64": {
    platform: "aarch64-apple-darwin",
    extension: "tar.gz",
    sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
  },
  "win32-x64": {
    platform: "x86_64-pc-windows-msvc",
    extension: "zip",
    sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
  },
  "win32-arm64": {
    platform: "aarch64-pc-windows-msvc",
    extension: "zip",
    sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
  },
}

function find(dir: string, name: string): string | undefined {
  for (const item of readdirSync(dir)) {
    const full = path.join(dir, item)
    if (statSync(full).isDirectory()) {
      const found = find(full, name)
      if (found) return found
      continue
    }
    if (item === name) return full
  }
  return undefined
}

export async function bundle(target: string, bin: string) {
  if (!(target in TARGETS)) throw new Error(`unknown VSIX target ${target}`)
  const config = TARGETS[target]
  if (!config) {
    console.log(`  ripgrep: no ${target} build upstream; this VSIX relies on a system rg`)
    return
  }
  const file = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${file}`
  const archive = await fetch(url).then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${url}: ${res.status}`))))
  const got = createHash("sha256").update(new Uint8Array(archive)).digest("hex")
  if (got !== config.sha256) throw new Error(`ripgrep checksum mismatch for ${file}: expected ${config.sha256}, got ${got}`)

  const dir = mkdtempSync(path.join(os.tmpdir(), "ripgrep-"))
  const local = path.join(dir, file)
  await Bun.write(local, archive)
  if (config.extension === "zip") await $`unzip -q -o ${local} -d ${dir}`
  else await $`tar -xzf ${local} -C ${dir}`
  const name = config.extension === "zip" ? "rg.exe" : "rg"
  const found = find(dir, name)
  if (!found) throw new Error(`${file} did not contain ${name}`)
  const out = path.join(bin, name)
  copyFileSync(found, out)
  if (name === "rg") chmodSync(out, 0o755)
  rmSync(dir, { recursive: true, force: true })
  if (!existsSync(out)) throw new Error(`could not place ${out}`)
  console.log(`  ripgrep ${VERSION} (${config.platform}) -> ${out}`)
}

if (import.meta.main) {
  const [target, bin] = process.argv.slice(2)
  if (!target || !bin) throw new Error("usage: bun script/ripgrep.ts <vsce-target> <bin-dir>")
  await bundle(target, bin)
}
