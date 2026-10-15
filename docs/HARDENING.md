# Restricted-egress build

This fork of Kilo Code ships a VS Code extension, and the CLI inside it, that connect only to hosts on an allowlist fixed at build time, use a single OpenAI-compatible provider, and have every Kilo cloud feature removed. End users install the VSIX and nothing else.

Upstream is the source of features. The fork is upstream tag `UPSTREAM` (see `packages/kilo-hardening/UPSTREAM`) plus a stack of `[hardened]` commits. Background: `docs/egress-inventory.md` (Phase 0 measurement) and `docs/hardening-plan.md` (decisions).

## Build configuration

`packages/kilo-hardening/hardening.config.json` is imported as JSON, so esbuild and `bun build` inline it into the extension and the CLI. Nothing on a user's machine can change it: no setting, environment variable or file. CI replaces the committed file with the real one before building.

| Key | Meaning |
|---|---|
| `identity.publisher`, `identity.name`, `identity.displayName` | Extension identity. `name` also replaces `kilo` as the config/data directory name and `kilo-code` as the command and settings namespace |
| `provider.id`, `provider.name`, `provider.baseURL`, `provider.models` | The preconfigured OpenAI-compatible provider. Users can add models and edit it in the extension; the base URL must stay on the allowlist |
| `allow.app` | Hosts the CLI and the extension may reach: provider, indexing endpoints, internal links. Entries: `{ "host": "..." }`, `{ "suffix": "..." }`, `{ "cidr": "..." }`, each with optional `"ports": [...]` |
| `allow.tools` | Hosts the model's tools may reach: agent commands (`bash`, `git`, `curl`), web fetch, MCP servers, the automated browser |
| `features.autocomplete`, `features.speechToText`, `features.imageGeneration` | Hidden features that can be switched back on. They need a non-gateway backend first (see Gaps) |
| `features.externalLinks` | Open documentation/support links in the system browser. Off: only allowlisted links open |
| `websearch.providers` | `[]`, `["exa"]`, `["parallel"]`. Each enabled provider's host is added to `allow.app` automatically |
| `websearch.permission` | `ask`, `allow` or `deny` for each search, forced over user and agent config |
| `websearch.audit` | Write time, provider host and query of every search to `search-audit.log` |
| `webfetch` | `tools` (fetch within the tools scope) or `off` |
| `sandbox` | Sandbox agent commands (Linux bubblewrap, macOS seatbelt) with network limited to `allow.tools` |

Loopback (`localhost`, `127.0.0.0/8`, `::1`) is always allowed in both scopes.

## How enforcement works

1. **Gates in code.** Features the build does not ship never attempt a connection: telemetry has no client, the Kilo gateway, marketplace, remote, cloud-session and console routes answer 404, built-in auth/provider plugins are not loaded, models.dev, share, presence, autoupdate and LSP downloads are forced off, npm installs and the ripgrep download are refused, and the PR link poller, session export and connectivity probe are off. The CLI config layer (`packages/opencode/src/kilocode/hardening/config.ts`) enforces the provider set, plugins, MCP, remote instructions/skills, indexing, sandbox and web tool permissions after every config source has been merged, and reports what it dropped as config warnings.
2. **Egress guard.** The CLI imports `@kilocode/kilo-hardening/install` first in its entry and in each worker. It wraps `fetch` (following redirects itself so each hop is checked), `WebSocket`, `Bun.connect`, `net`/`tls` sockets and `http(s).request/get`. The extension's guard is scoped to its own bundle, because the extension host is shared with other extensions: an esbuild plugin points our `net`, `tls`, `http`, `https` and `vscode` imports at guarded shims and rewrites `fetch`/`WebSocket`. A denial throws `EgressDeniedError` naming the host and scope and appends a JSON line to `<data>/log/egress-denied.log`.
3. **Allowlist proxy.** The extension runs a token-protected proxy on `127.0.0.1` with one port per scope and starts the CLI with `HTTP(S)_PROXY`/`ALL_PROXY` set to the tools port, after every other variable so nothing overrides it. The CLI's own fetches use the app port; its child processes inherit the tools port. The proxy checks names before DNS and checks CIDR rules against the address it dials.
4. **Sandbox.** Where a backend exists, agent commands run sandboxed with network limited to the tools hosts, which also covers tools that ignore proxy variables.

## Gaps

- Native addons and child processes that ignore proxy variables are not covered on Windows (no sandbox backend) or on Linux without bubblewrap. The CLI reports a config warning when the sandbox is unavailable.
- Agent Manager runs `git` against the repository's configured remotes from the extension host, as the user's own git would.
- The webview renderer is not covered by the guard; its CSP blocks remote images and its network access goes through the extension.
- Links opened in the system browser leave VS Code; non-allowlisted http(s) links do not open unless `features.externalLinks` is on.
- Autocomplete, speech-to-text and image generation only have Kilo-gateway backends today. Turning their features on needs a generic backend first (for autocomplete: a FIM target that posts `prompt` + `suffix` to `/v1/completions`).
- LanceDB (the default local vector store) is installed from npm on first use, which the build refuses. Indexing needs Qdrant until LanceDB ships in the VSIX.
- Upstream unit test `orphan-size … unreadable directory` fails when tests run as root; this predates the fork.

## Checks

| Check | Command (from `packages/kilo-hardening/`) |
|---|---|
| Unit tests (matcher, policy, guard, proxy, bundle, identity, canary) | `bun test` |
| URL canary: every host in runtime source is reviewed | `bun script/canary.ts` |
| Zero-egress integration test | `bun script/egress-test.ts` (CI runs it in a `--network none` container) |
| Inventory below is current | `bun script/inventory.ts --check` |

## Syncing with upstream

```bash
cd packages/kilo-hardening
bun script/sync.ts v7.8.13 --report sync-v7.8.13.md   # replay every patch, report all conflicts
bun script/sync.ts v7.8.13 --stop                      # or stop at the first conflict to resolve it
```

The script creates `hardened/sync-<tag>` at the upstream tag and cherry-picks the stack. `bun.lock` conflicts resolve by taking upstream's file and running `bun install`; source conflicts by re-applying the patch's intent on the new code. After a clean replay: run the checks above, update `UPSTREAM`, regenerate this inventory, then move the main branch to the sync branch.

## Patch inventory

Generated by `bun script/inventory.ts`: every `[hardened]` patch that edits a file present in the upstream base. Patches that only add files (all of `packages/kilo-hardening/`, `packages/opencode/src/kilocode/hardening/`, tests, docs) cannot conflict and are not listed.

<!-- inventory:start -->
| Patch | Upstream files edited |
|---|---|
| feat(hardening): add baked config, host allowlist and egress policy | `bun.lock` |
| feat(cli): install the egress guard first in the CLI and its workers | `bun.lock`<br>`packages/opencode/package.json`<br>`packages/opencode/src/cli/tui/worker.ts`<br>`packages/opencode/src/index.ts`<br>`packages/opencode/src/kilocode/indexing-worker.ts`<br>`packages/opencode/src/kilocode/session-export/worker.ts` |
| feat(vscode): guard the extension bundle's own network clients | `bun.lock`<br>`packages/kilo-vscode/esbuild.js`<br>`packages/kilo-vscode/package.json`<br>`packages/kilo-vscode/src/extension.ts` |
| feat(vscode): route the CLI through a loopback allowlist proxy | `packages/kilo-vscode/src/services/cli-backend/server-manager.ts` |
| feat(telemetry): make telemetry impossible in the restricted build | `bun.lock`<br>`packages/kilo-telemetry/package.json`<br>`packages/kilo-telemetry/src/client.ts`<br>`packages/kilo-telemetry/src/telemetry.ts` |
| feat: use the build's own config and data directories | `bun.lock`<br>`packages/core/package.json`<br>`packages/core/src/global.ts`<br>`packages/kilo-vscode/src/agent-manager/pool/home.ts`<br>`packages/kilo-vscode/src/agent-manager/project/avatar.ts`<br>`packages/kilo-vscode/src/documents/document-reader.ts`<br>`packages/kilo-vscode/src/kilo-provider/config-file.ts` |
| feat(cli): enforce the single-provider policy in config loading | `packages/opencode/src/config/config.ts` |
| feat(vscode): validate custom provider base URLs against the allowlist | `packages/kilo-vscode/tests/unit/custom-provider-dialog-validate.test.ts`<br>`packages/kilo-vscode/webview-ui/src/components/settings/CustomProviderDialog.tsx`<br>`packages/kilo-vscode/webview-ui/src/components/settings/CustomProviderValidation.ts` |
| feat(cli): refuse server routes that reach the Kilo cloud | `packages/opencode/src/kilocode/server/httpapi/server.ts` |
| feat(cli): switch off cloud integrations at their source | `packages/opencode/src/kilo-sessions/pr-link-poller.ts`<br>`packages/opencode/src/kilocode/session-export/eligibility.ts`<br>`packages/opencode/src/plugin/index.ts`<br>`packages/opencode/src/plugin/openai/ws.ts`<br>`packages/opencode/src/session/network.ts` |
| feat(core): no runtime downloads from npm or GitHub | `packages/core/src/npm.ts`<br>`packages/core/src/ripgrep/binary.ts` |
| feat(vscode): keep extension-host side effects inside the allowlist | `packages/kilo-vscode/src/agent-manager/PRStatusPoller.ts`<br>`packages/kilo-vscode/src/agent-manager/project/avatar.ts`<br>`packages/kilo-vscode/src/services/browser-automation/browser-proxy.ts`<br>`packages/kilo-vscode/src/webview-html-utils.ts` |
| feat(vscode): remove marketplace, Kilo account and cloud UI | `packages/kilo-vscode/esbuild.js`<br>`packages/kilo-vscode/src/MarketplacePanelProvider.ts`<br>`packages/kilo-vscode/src/SettingsEditorProvider.ts`<br>`packages/kilo-vscode/src/extension.ts`<br>`packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx`<br>`packages/kilo-vscode/webview-ui/src/components/chat/SidebarTopBar.tsx`<br>`packages/kilo-vscode/webview-ui/src/components/history/HistoryView.tsx`<br>`packages/kilo-vscode/webview-ui/src/components/settings/Settings.tsx` |
| feat(vscode): give the packaged extension its own identity | `packages/kilo-vscode/.gitignore`<br>`packages/kilo-vscode/.vscodeignore`<br>`packages/kilo-vscode/script/build.ts` |
| feat(cli): apply the build's web search and web fetch policy | `packages/opencode/src/tool/webfetch.ts`<br>`packages/opencode/src/tool/websearch.ts` |
<!-- inventory:end -->

## Sync log

| Date | From | To | Result |
|---|---|---|---|
| 2026-10-15 | v7.8.8 (brief) | v7.8.12 | Baseline reset to the exact tag before any patches |
| 2026-10-15 | v7.8.12 | upstream `main` at 204c6e8 (18 commits past v7.8.12, rehearsal) | 21 patches applied, 0 conflicts, canary clean. A newer tag did not exist yet |
