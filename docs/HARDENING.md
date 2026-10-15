# Restricted-egress build

This fork of Kilo Code ships a VS Code extension, and the CLI inside it, that connect only to hosts on an allowlist fixed at build time, use only OpenAI-compatible providers on that allowlist, and have every Kilo cloud feature removed. End users install the VSIX and nothing else.

Upstream is the source of features. The fork is upstream tag `UPSTREAM` (see `packages/kilo-hardening/UPSTREAM`) plus a stack of `[hardened]` commits. Background: `docs/egress-inventory.md` (Phase 0 measurement) and `docs/hardening-plan.md` (decisions). Rollout: `docs/INSTALL.md`.

## Build configuration

`packages/kilo-hardening/hardening.config.json` is imported as JSON, so esbuild and `bun build` inline it into the extension and the CLI. Nothing on a user's machine can change it: no setting, environment variable or file. CI replaces the committed file with the `HARDENING_CONFIG` secret when it is set.

Every key is optional. The committed file is `{}`: identity `dyvoid.code-agent`, no preconfigured provider, an allowlist of loopback only, features off, web search off, web fetch in the tools scope, sandbox on.

| Key | Meaning |
|---|---|
| `identity.publisher`, `identity.name`, `identity.displayName` | Extension identity. `name` also replaces `kilo` as the config/data directory name and `kilo-code` as the command and settings namespace |
| `provider.baseURL`, `provider.id`, `provider.name`, `provider.models` | Optional preconfigured OpenAI-compatible provider; only `baseURL` is required (`id` defaults to `llm`, `models` to none). Without it users add their own provider in the extension. Either way the base URL must be on loopback or `allow.app` |
| `allow.app` | Hosts the CLI and the extension may reach for their own features: provider, indexing endpoints, internal links. Entries: `{ "host": "..." }`, `{ "suffix": "..." }`, `{ "cidr": "a.b.c.d/n" }`, each with optional `"ports": [...]`. Hosts are names or four-part IPv4/IPv6 addresses; a port-restricted entry never matches an unknown port |
| `allow.tools` | Hosts the model may direct traffic to: agent commands (`bash`, `git`, `curl`), web fetch, remote MCP servers, the automated browser. The CLI process itself may reach `app` and `tools` hosts (its `cli` scope); model-chosen destinations are checked against `tools` only |
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
2. **Egress guard.** The CLI imports `@kilocode/kilo-hardening/install` first in its entry and in each worker. It wraps `fetch` and `fetch.preconnect` (following redirects itself so each hop is checked, and refusing redirects to non-HTTP schemes), `WebSocket`, `Bun.connect`, `Bun.udpSocket`, `net`/`tls` sockets, `http(s).request/get`, `http.ClientRequest` and `dgram`; Bun's built-in SQL, Redis and S3 clients are switched off and `s3://` paths in `Bun.file`/`Bun.write` are refused. Web fetch narrows each request and its redirects to the tools scope. Code that resolves and vets a name itself and dials the address (the command sandbox's proxy) marks the connection with the vetted name (`Symbol.for("kilo.hardening.checked")`), which the guard checks instead of the address. Only `http(s)`/`ws(s)` URLs to allowed hosts and local `data:`/`blob:`/`file:` URLs pass. Proxy variables naming a host outside the allowlist are removed at startup, and fetches they would carry are refused. The extension's guard is scoped to its own bundle, because the extension host is shared with other extensions: an esbuild plugin points our `net`, `tls`, `http`, `https`, `http2`, `dgram` and `vscode` imports at guarded shims and rewrites `fetch`/`WebSocket`. A denial throws `EgressDeniedError` naming the host and scope and appends a JSON line to `<data>/log/egress-denied.log`.
3. **Allowlist proxy.** The extension runs a proxy on `127.0.0.1` with two ports, each with its own token: `cli` (app and tools hosts) for the CLI's own fetches, and `tools` for everything the CLI starts. The CLI gets `HTTP(S)_PROXY`/`ALL_PROXY` set to the tools port, after every other variable so nothing overrides it; commands the model runs never see the cli port or its token. The proxy checks names before DNS and checks CIDR rules against the address it dials.
4. **Sandbox.** Where a backend exists, agent commands run sandboxed with network limited to the tools hosts, which also covers tools that ignore proxy variables.

## Gaps

- Native addons and child processes that ignore proxy variables are not covered on Windows (no sandbox backend) or on Linux without bubblewrap. The CLI reports a config warning when the sandbox is unavailable.
- The sandbox's own proxy takes exact host names on public addresses: `allow.tools` IP, CIDR and suffix entries, and hosts that resolve to private addresses, are not reachable from sandboxed commands. Without a port list a host is opened on 443 and 80. The VSIX build log counts such entries.
- `Bun.fetch` is read-only and cannot be wrapped. In the CLI it still goes through the proxy variables (the extension's tools proxy); run standalone, nothing checks it. The canary fails if runtime source calls it.
- DNS is not filtered: lookups go to the system resolver, and names only a CIDR entry could allow are resolved before the check. For such names the in-process check and the connection resolve separately (DNS rebinding); the allowlist proxy dials the address it checked.
- Agent Manager runs `git` and `gh` against the repository's configured remotes and GitHub from the extension host, as the user's own tools would.
- The webview renderer is not covered by the guard; its CSP blocks remote images and its network access goes through the extension. A link clicked in a webview that the webview does not hand to the extension is opened by VS Code itself, behind its own external-link prompt.
- Links opened through the extension leave VS Code only for allowlisted http(s) hosts (any http(s) host with `features.externalLinks`), `mailto:` and this extension's own `vscode://` handler.
- The CLI still reads `~/.kilo` and `~/.kilocode` (upstream's home config and skills directories), so a side-by-side upstream install's config there applies too, after the restricted-build policy.
- Autocomplete, speech-to-text and image generation only have Kilo-gateway backends today. Turning their features on needs a generic backend first (for autocomplete: a FIM target that posts `prompt` + `suffix` to `/v1/completions`).
- LanceDB (the default local vector store) is installed from npm on first use, which the build refuses. Indexing needs Qdrant until LanceDB ships in the VSIX.
- Upstream unit test `orphan-size … unreadable directory` fails when tests run as root; this predates the fork.

## Checks

| Check | Command (from `packages/kilo-hardening/`) |
|---|---|
| Unit tests (matcher, policy, guard, proxy, bundle, identity, canary) | `bun test` |
| URL canary: every host in runtime source is reviewed | `bun script/canary.ts` |
| Zero-egress integration test | `bun script/egress-test.ts` (CI runs it under strace in a network namespace with only loopback) |
| Inventory below is current | `bun script/inventory.ts --check` |

CI: `.github/workflows/hardening.yml` runs all of these on pull requests and on pushes to `main`, `claude/**` and `hardened/**`, plus the CLI and extension typecheck, lint, knip and unit tests; the egress test runs in a fresh network namespace with only loopback. `.github/workflows/hardening-vsix.yml` builds the VSIX packages and `SHA256SUMS` from the `HARDENING_CONFIG` secret, versioned from the `hardened-vX.Y.Z` tag or the run's `version` input. Upstream's release workflows only run in `Kilo-Org/kilocode`; other upstream workflows (JetBrains, docs, community automation) still trigger in the fork and can be disabled in the repository's Actions settings without touching their files.

## Syncing with upstream

```bash
cd packages/kilo-hardening
bun script/sync.ts v7.8.13 --report sync-v7.8.13.md   # replay every patch, report all conflicts
bun script/sync.ts v7.8.13 --stop                      # or stop at the first conflict to resolve it
```

The script creates `hardened/sync-<tag>` at the upstream tag and cherry-picks every `[hardened]` commit. Other commits are listed, not replayed; merge commits are skipped, so keep fixes out of merges. A conflict only in `bun.lock` keeps upstream's lockfile and applies the rest of the patch; run `bun install` afterwards. Source conflicts are resolved by re-applying the patch's intent on the new code. After `--stop`, resolve, `git cherry-pick --continue`, and rerun with `--from <your branch>`. After a clean replay: run the checks above, update `UPSTREAM`, regenerate this inventory, then move the main branch to the sync branch.

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
| feat: ship ripgrep in the VSIX | `packages/core/src/ripgrep/binary.ts`<br>`packages/kilo-vscode/script/build.ts` |
| ci: hardening checks and VSIX build workflows | `script/check-workflows.ts` |
| docs: explain the fork at the top of the README | `README.md` |
| fix(hardening): close egress guard gaps found in review | `packages/kilo-sandbox/src/proxy.ts`<br>`packages/kilo-vscode/src/services/browser-automation/browser-proxy.ts`<br>`packages/opencode/src/kilocode/process/env.ts`<br>`packages/opencode/src/plugin/openai/ws.ts` |
| fix(cli): tighten route gate and config policy | `packages/opencode/src/kilocode/indexing.ts`<br>`packages/opencode/src/mcp/index.ts`<br>`packages/opencode/src/server/routes/instance/httpapi/server.ts`<br>`packages/opencode/src/tool/webfetch.ts` |
| fix(vscode): hide remaining cloud entry points; safer packaging | `packages/kilo-vscode/script/build.ts`<br>`packages/kilo-vscode/src/extension.ts`<br>`packages/kilo-vscode/webview-ui/src/components/history/HistoryView.tsx`<br>`packages/kilo-vscode/webview-ui/src/components/settings/ModelsTab.tsx`<br>`packages/kilo-vscode/webview-ui/src/components/settings/Settings.tsx`<br>`packages/kilo-vscode/webview-ui/src/components/settings/settings-search.ts` |
<!-- inventory:end -->

## Sync log

| Date | From | To | Result |
|---|---|---|---|
| 2026-10-15 | v7.8.8 (brief) | v7.8.12 | Baseline reset to the exact tag before any patches |
| 2026-10-15 | v7.8.12 | upstream `main` at 204c6e8 (18 commits past v7.8.12, rehearsal) | 21 patches applied, 0 conflicts, canary clean. A newer tag did not exist yet |
