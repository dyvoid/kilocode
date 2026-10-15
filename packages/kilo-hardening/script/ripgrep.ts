#!/usr/bin/env bun
/**
 * Build-time: puts ripgrep next to the CLI binary in the VSIX's bin/ so the restricted build never
 * downloads it at runtime (the CLI looks there when hardened, see core/src/ripgrep/binary.ts).
 * The archive is checked against the .sha256 file ripgrep publishes with each release asset.
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
export const TARGETS: Record<string, { platform: string; extension: "tar.gz" | "zip" } | undefined> = {
  "linux-x64": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
  "linux-arm64": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
  "alpine-x64": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
  "alpine-arm64": undefined,
  "darwin-x64": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
  "darwin-arm64": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
  "win32-x64": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  "win32-arm64": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
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
  const [archive, sum] = await Promise.all([
    fetch(url).then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${url}: ${res.status}`)))),
    fetch(`${url}.sha256`).then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${url}.sha256: ${res.status}`)))),
  ])
  // Unix assets: "<hash>  <file>"; Windows assets: CertUtil output. Take the hash token.
  const want = /\b[0-9a-f]{64}\b/i.exec(sum)?.[0]?.toLowerCase()
  const got = createHash("sha256").update(new Uint8Array(archive)).digest("hex")
  if (!want || want !== got) throw new Error(`ripgrep checksum mismatch for ${file}: expected ${want}, got ${got}`)

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
