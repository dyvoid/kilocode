# Hardening plan (Phase 1, awaiting owner approval to start Phase 2)

Inputs: `docs/egress-inventory.md` and the project brief. Nothing here is implemented yet.

## Owner decisions

| Topic | Decision |
|---|---|
| Baseline | Exact upstream tag `v7.8.12` (done) |
| Who changes the allowlist | Build time only. No admin file, setting or env override on the machine. A change ships as a new VSIX |
| Allowlist at launch | Loopback plus the LLM host(s). No internal suffixes, no blanket private ranges. LAN indexing servers are added as individual host entries |
| Allowlist scopes | Two scopes: `app` (CLI and extension features: provider, indexing, web search) and `tools` (agent commands, web fetch, MCP) |
| Network path to the LLM host | Direct, no corporate proxy |
| Provider auth | None for now |
| Side-by-side install | Build-time rename of the `kilo-code.*` namespace; separate config/data directory |
| Agent commands | Sandbox on by default on Linux/macOS; Windows gap accepted and documented |
| Indexing | Allowed with local embedding/vector providers on loopback and LAN hosts in the allowlist |
| Speech-to-text, image generation | Hidden behind build-config flags so they can be re-enabled |
| Package location | `packages/kilo-hardening/` |
| Still open (brief section 6) | 3 publisher/name, 5 autocomplete, 6 distribution channel, 7 external links, 8 search provider and keys, 9 search permission policy, 10 web fetch default, 11 search audit log |

## Allowlist

Source: `hardening.config.json`, compiled into the extension and the CLI as a constant at build time. The repo ships `hardening.config.example.json`; CI supplies the real file. Nothing on the user's machine can change it.

```json
{
  "allow": {
    "app": [{ "host": "llm.corp.example" }, { "host": "embed.lan.corp.example" }],
    "tools": [{ "host": "llm.corp.example" }]
  }
}
```

Entry kinds: `host` (exact), `suffix`, `cidr`, each with an optional port list. `localhost`, `127.0.0.0/8` and `::1` are implicit in both scopes. A web search provider host is added to `app` by build config when search is enabled.

Enforcement:

1. **Loopback allowlist proxy in the extension host.** The extension starts it before spawning the CLI and sets `HTTP(S)_PROXY`/`ALL_PROXY` for the CLI. It listens on two ports: one for the CLI's own traffic (`app` scope), one handed to spawned tools (`tools` scope). Hostnames are checked before any DNS lookup. `cidr` entries are checked against the address the proxy itself resolved and connects to, so there is no check/use gap.
2. **In-process guard**, first import in both processes. Wraps `fetch`, `node:http(s)`, `net`/`tls`, `globalThis.WebSocket` and `Bun.connect`, and denies anything that bypasses the proxy with a typed `EgressDeniedError` (host, scope) plus a local log line. Bun gaps from Phase 0 (captured native `fetch`, the `ws` shim) are closed by loading first and by explicit checks at the three `ws` call sites.
3. **Sandbox for agent commands** on Linux/macOS (`@kilocode/sandbox`), with `allowed_hosts` set from the `tools` scope, so tools that ignore proxy variables are confined too.
4. **Gates in code** so disabled features never attempt a connection (acceptance criterion 12; the R7 test counts denials as failures).

Users configure the provider base URL, models and indexing endpoint inside the extension. Each value is validated against the matching scope on entry, with an error naming the host and the scope. Users cannot widen the list.

TLS: internal CAs in the OS trust store already work. The release CLI runs with `--use-system-ca` (`packages/opencode/script/build.ts:334`) and the extension sets `NODE_USE_SYSTEM_CA=1` (`server-manager.ts:132`). Verified from source, not at runtime.

Documented gaps: native addons; on Windows, child processes that ignore proxy variables; the webview renderer (handled by CSP); the system browser opened by `openExternal`.

## Design summary

`packages/kilo-hardening/` holds the config schema, the baked config module, the host matcher (exact, suffix, CIDR via `ipaddr.js`), the guard, the proxy and the spawn-env builder. A path containing `kilo` is exempt from `kilocode_change` markers and the annotation check, which keeps the upstream diff to the hook lines listed below. Dev builds additionally accept `KILO_HARDENING_CONFIG` for tests; production builds ignore it.

## Patch list

Size: lines changed in upstream files (new files not counted). "Hook" means a one-line import or guarded early return.

| # | Patch | Upstream files touched | Upstream lines | New code |
|---|---|---|---|---|
| 1 | Reset branch to exact tag `v7.8.12` | none | 0 | 0 (done) |
| 2 | `packages/kilo-hardening` scaffold: config schema with `app`/`tools` scopes, baked config module, host matcher (exact, suffix, CIDR via `ipaddr.js`), typed `EgressDeniedError`, local log | `package.json` workspaces (already globbed: 0) | 0 | ~400 |
| 3 | CLI guard install: first import in CLI entry | `packages/opencode/src/index.ts` | 1 | ~250 |
| 4 | Extension guard install: first import in activation | `packages/kilo-vscode/src/extension.ts` | 1 | shared |
| 4a | Loopback allowlist proxy in the extension host (two ports, `app` and `tools`), started before the CLI | `server-manager.ts` (same hook as 5) | 0 | ~250 |
| 5 | Spawn env: proxy variables and hardened keys applied last so the user's shell cannot override them; sandbox on by default with `tools` hosts | `packages/kilo-vscode/src/services/cli-backend/server-manager.ts` | ~3 | ~60 |
| 6 | Telemetry hard-off: `Client.init` creates no PostHog client in hardened builds; `setEnabled` becomes a no-op | `packages/kilo-telemetry/src/client.ts` (Kilo-owned) | ~4 | 0 |
| 7 | Separate state: build-time app name instead of `kilo` for config/data/cache dirs, so a side-by-side upstream install does not share auth, sessions or config | `packages/core/src/global.ts` | 1 | 0 |
| 8 | Single provider: hardened config layer sets `enabled_providers`, injects the generic provider entry, `KILO_DISABLE_MODELS_FETCH`, `KILO_DISABLE_DEFAULT_PLUGINS`, no autocomplete/embedding providers | `packages/opencode/src/config/config.ts` (one hook into the existing Kilo config pipeline) | ~3 | ~150 |
| 9 | Base URL validation against the allowlist (CLI config load and the extension's custom provider dialog) | `config.ts` (same hook), `webview-ui/.../CustomProviderValidation.ts` | ~3 | ~60 |
| 10 | Cloud surface gates: marketplace route, indexing models, Kilo gateway/auth routes, cloud sessions, remote, share, session export, PR poller, cloud agent, Atomic Chat/Anaconda discovery, connectivity probe (probe only the provider host), ripgrep download (bundle `rg` in the VSIX instead), runtime npm installs | ~12 files, one guarded early return each | ~25 | ~40 |
| 11 | `ws` call-site checks (Codex WS, remote WS, event service) | 3 files | ~3 | 0 |
| 12 | UI: hide marketplace/profile entries, cloud session list, gateway provider cards, Kilo notifications; speech-to-text and image generation hidden behind build-config flags; old command IDs registered as no-ops | `SidebarTopBar.tsx`, `extension.ts` command registration, ~5 webview components | ~20 | ~80 |
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
3. **Corporate proxies.** Not needed at launch (direct path to the LLM host). The loopback proxy connects directly; chaining to an upstream proxy is deferred until a deployment needs it.
4. **Upstream churn.** Between v7.8.8 and v7.8.12 a new gateway host and env var appeared. The canary (patch 18) is what catches this on each sync.
