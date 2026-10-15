# Hardening plan (Phase 1 draft, awaiting owner approval)

Inputs: `docs/egress-inventory.md` and the project brief. Nothing here is implemented yet.

## Design summary

Three layers, each covering what the one before cannot:

1. **Gate in code.** Every surface the hardened build does not need is switched off before it opens a socket. Acceptance criterion 12 and the R7 test ("zero denied attempts") require this: a guard denial still counts as an attempt.
2. **In-process guard** (`@kilocode/hardening`, loaded first in the CLI and the extension host). Wraps `fetch`, `node:http(s)`, `net`/`tls`, `globalThis.WebSocket` and `Bun.connect`. In Node this is near complete (socket-level hooks catch everything measured). In Bun it is not: native `fetch` references captured before the guard loads and the `ws` shim bypass it, so the guard must be the first import and the three `ws` call sites get an explicit check.
3. **Enforcing loopback proxy** for the CLI and its child processes. The guard starts an allowlist CONNECT proxy inside the CLI and sets `HTTP(S)_PROXY`/`NO_PROXY` for its own fetches and for spawned tools (`bash`, `git`, `npm`, LSP). The capture showed every CLI request honouring these variables. It chains to the user's corporate proxy when one is configured. Processes that ignore proxy variables remain uncovered; on Linux/macOS the existing `@kilocode/sandbox` (bubblewrap/seatbelt plus `allowed_hosts`) can close that gap for agent tools, Windows has no backend.

Documented gaps: native addons, child processes that ignore proxy variables (Windows always; Linux/macOS when the sandbox is off), the webview renderer (handled by CSP instead), the system browser opened by `openExternal`.

Package location: `packages/kilo-hardening/`. A path containing `kilo` is exempt from `kilocode_change` markers and the annotation check, which keeps the upstream diff to the hook lines listed below.

Build-time config: `hardening.config.json` (allowlist, provider defaults, search settings, flags) is compiled into both bundles as a generated TS module. Production builds read only that module; dev builds additionally accept `KILO_HARDENING_CONFIG` for tests.

## Patch list

Size: lines changed in upstream files (new files not counted). "Hook" means a one-line import or guarded early return.

| # | Patch | Upstream files touched | Upstream lines | New code |
|---|---|---|---|---|
| 1 | Rebase branch onto exact tag `v7.8.12` (drop the extra merged PR) | none | 0 | 0 |
| 2 | `packages/kilo-hardening` scaffold: config schema, baked config module, host matcher (exact, suffix, CIDR via `ipaddr.js`), typed `EgressDeniedError`, local log | `package.json` workspaces (already globbed: 0) | 0 | ~400 |
| 3 | CLI guard install: first import in CLI entry | `packages/opencode/src/index.ts` | 1 | ~250 |
| 4 | Extension guard install: first import in activation | `packages/kilo-vscode/src/extension.ts` | 1 | shared |
| 5 | Spawn env: hardened keys applied last so the user's shell cannot override them | `packages/kilo-vscode/src/services/cli-backend/server-manager.ts` | ~3 | ~60 |
| 6 | Telemetry hard-off: `Client.init` creates no PostHog client in hardened builds; `setEnabled` becomes a no-op | `packages/kilo-telemetry/src/client.ts` (Kilo-owned) | ~4 | 0 |
| 7 | Separate state: build-time app name instead of `kilo` for config/data/cache dirs, so a side-by-side upstream install does not share auth, sessions or config | `packages/core/src/global.ts` | 1 | 0 |
| 8 | Single provider: hardened config layer sets `enabled_providers`, injects the generic provider entry, `KILO_DISABLE_MODELS_FETCH`, `KILO_DISABLE_DEFAULT_PLUGINS`, no autocomplete/embedding providers | `packages/opencode/src/config/config.ts` (one hook into the existing Kilo config pipeline) | ~3 | ~150 |
| 9 | Base URL validation against the allowlist (CLI config load and the extension's custom provider dialog) | `config.ts` (same hook), `webview-ui/.../CustomProviderValidation.ts` | ~3 | ~60 |
| 10 | Cloud surface gates: marketplace route, indexing models, Kilo gateway/auth routes, cloud sessions, remote, share, session export, PR poller, cloud agent, Atomic Chat/Anaconda discovery, connectivity probe (probe only the provider host), ripgrep download (bundle `rg` in the VSIX instead), runtime npm installs | ~12 files, one guarded early return each | ~25 | ~40 |
| 11 | `ws` call-site checks (Codex WS, remote WS, event service) | 3 files | ~3 | 0 |
| 12 | UI: hide marketplace/profile entries, cloud session list, gateway provider cards, Kilo notifications, speech-to-text/image-gen when backed by the gateway; old command IDs registered as no-ops | `SidebarTopBar.tsx`, `extension.ts` command registration, ~5 webview components | ~20 | ~80 |
| 13 | Manifest: build-time transform of `package.json` (publisher, name, displayName, removed commands/menus/keybindings, namespace rename) instead of editing the source manifest | none | 0 | ~120 |
| 14 | Webview CSP: `img-src` limited to `cspSource` and `data:` | `src/webview-html-utils.ts` | 1 | 0 |
| 15 | Web search: build-config flags into spawn env, permission default `ask` (or as decided), optional audit log, redact Exa key in URLs/errors | `websearch.ts` audit hook | ~3 | ~80 |
| 16 | Web fetch: guard denial returned as a readable tool error; default per decision | `webfetch.ts` | ~2 | ~20 |
| 17 | `docs/HARDENING.md` patch inventory and `script/hardening/rebase.ts` (rebase onto a tag, report conflicts per patch) | none | 0 | ~150 |
| 18 | CI canary: URL/host scanner over in-scope runtime source vs `hardening/reviewed-hosts.txt` | `script/check-workflows.ts` allowlist + one workflow | ~2 | ~200 |
| 19 | Integration test: CLI + mock OpenAI server in a `--network none` container, scripted session, assert zero guard denials (built from the Phase 0 harness) | workflow | 0 | ~250 |
| 20 | VSIX build per platform with checksums, config injection, IT rollout doc | workflow | 0 | ~150 |

Total upstream-file footprint estimate: about 75 lines across about 30 files, plus manifest handling done at build time. Patches 2-16 are R1-R5 and R9; 17-20 are R6-R8.

## Risks and open technical questions

1. **R5 side-by-side install.** The manifest contributes 117 `kilo-code.*` IDs (commands, views, settings), referenced from 51 source files. Two extensions contributing the same IDs collide (duplicate command registration fails; settings are shared). Patch 13 handles this with a build-time rename over the manifest and bundled output; it needs a check that no ID is assembled dynamically at runtime.
2. **Bun guard coverage.** The guard cannot see `fetch` references captured before it loads. Mitigation: first import, plus the loopback proxy, plus the canary. Worth a test that imports the CLI entry and asserts `globalThis.fetch` is the guarded one when the first provider call happens.
3. **Corporate proxies.** Users behind an authenticating proxy need the loopback proxy to chain correctly. The extension already maps `http.proxy` into env (`server-manager.ts:320-381`).
4. **Upstream churn.** Between v7.8.8 and v7.8.12 a new gateway host and env var appeared. The canary (patch 18) is what catches this on each sync.
