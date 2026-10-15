# Egress inventory (Phase 0)

Baseline: upstream tag `v7.8.12` (`8001cdc`). The working branch is `v7.8.12` plus upstream PR #14774 (Agent Manager terminal ownership, 5 files, no network code). No hardening changes exist yet.

## Method

| Item | Detail |
|---|---|
| Process | Local CLI backend (`bun dev serve`) with the spawn variables the VS Code extension sets (`KILO_CLIENT=vscode`, `KILO_TELEMETRY_LEVEL=all`, `KILO_PLATFORM=vscode`, etc.), clean `HOME`/XDG dirs |
| Network | `HTTP(S)_PROXY`/`ALL_PROXY` pointed at a local deny-all CONNECT proxy that logs each target; `strace -f -e connect,sendto` on the CLI process tree to catch anything bypassing the proxy |
| LLM | Local mock OpenAI-compatible server on `127.0.0.1`, configured as the only provider |
| Script | Startup; GET on every non-parameterised server route (stand-in for UI and settings loads); `POST /telemetry/setEnabled {"enabled":true}`; create session; one prompt that triggers a `bash` tool call, a follow-up turn and title generation; 30 minutes idle |
| Not measured at runtime | The VS Code extension host and webview (no VS Code in the capture container), the TUI, LSP downloads, ripgrep download (`rg` present on the host), MCP, indexing, autocomplete, speech-to-text, image generation, Kilo-authenticated flows |

Harness scripts are not committed yet; they become the basis of the R7 integration test.

All CLI egress observed honoured the proxy variables: strace recorded zero direct non-loopback `connect()` calls. Denial changes later behaviour (for example, a successful models.dev fetch would not be retried), so counts below are attempts under deny, which is the posture the hardened build will have.

## Measured (CLI)

| Host | Trigger | Count | Source |
|---|---|---|---|
| `models.dev` | Startup (hourly refresh fork) and `GET /config/providers` | 2 | `packages/core/src/models-dev.ts:268-270` |
| `us.i.posthog.com` | Startup, and again after `POST /telemetry/setEnabled true` / session events | 4 (startup) + 1 | `packages/kilo-telemetry/src/client.ts:9` |
| `ai-gateway.kilo.ai` | `GET /config/providers`, `GET /indexing/models` | 3 | `packages/kilo-gateway/src/api/constants.ts` (`DEFAULT_KILO_AI_GATEWAY_URL`) |
| `api.kilo.ai` | `GET /kilocode/marketplace` (CLI route, not only the extension) | 12 | `packages/opencode/src/kilocode/marketplace/api.ts:12` |
| _none_ | 30 minutes idle after the session (09:22-09:52 UTC) | 0 | |

The idle run had `KILO_DISABLE_MODELS_FETCH=1` (see below), and the models.dev refresh interval is 60 minutes, so the 30-minute window cannot show that refresh. PostHog sent nothing while idle because no events were queued. strace confirmed no direct connections during the idle window.

Side finding: in a dev (unbundled) run, a blocked `models.dev` makes every prompt fail with `HttpClientError 403 GET https://models.dev/api.json`, even with a fully configured custom provider. Release builds embed a models snapshot (`packages/opencode/script/build.ts`), so this affects dev and test runs only. The hardened build must set `KILO_DISABLE_MODELS_FETCH` and ship its own snapshot or none.

## Static leads: CLI (`packages/opencode`, `packages/core`, gateway, telemetry)

Status column: **M** measured above, **S** static analysis only.

| Surface | Hosts | Trigger | Existing gate | Status |
|---|---|---|---|---|
| Telemetry | `us.i.posthog.com` | Init; any `track()`; `Telemetry.setEnabled(true)` | `KILO_TELEMETRY_LEVEL` read once in `Telemetry.init` (`packages/kilo-telemetry/src/telemetry.ts:92`). `setEnabled` (`telemetry.ts:102`) and `Client.setEnabled` (`client.ts:51`) call `optIn()` with no env check. Route: `packages/opencode/src/kilocode/server/httpapi/handlers/telemetry.ts:22`. Extension calls it on every connect: `packages/kilo-vscode/src/extension.ts:138,158` | M, brief confirmed |
| Telemetry identity | `api.kilo.ai` (profile) | `Telemetry.updateIdentity` with a Kilo token | `isEnabled()` | S |
| Kilo gateway (API, auth, profile, notifications, models) | `api.kilo.ai`, `app.kilo.ai` | Kilo provider, login, `/kilo/*` routes | `KILO_API_URL` | S |
| Kilo AI gateway (new since v7.8.8) | `ai-gateway.kilo.ai` | Kilo provider model list, chat, FIM, embeddings, indexing models | `KILO_AI_GATEWAY_URL`, else derived from `KILO_API_URL` | M |
| Event service | `wss://events.kiloapps.io` | Kilo chat events after login | `EVENT_SERVICE_URL` | S |
| Marketplace (CLI route) | `api.kilo.ai/api/marketplace` | `GET /kilocode/marketplace` | `KILO_MARKETPLACE_BASE_URL` | M |
| Session ingest / cloud sessions | `ingest.kilosessions.ai` | Kilo token present | `KILO_SESSION_INGEST_URL`; token | S |
| Cloud agent | `cloud-agent-next.kilosessions.ai`, `kilo.ai` | Cloud/remote features | Origin parser in `packages/opencode/src/kilocode/cloud/origin.ts` | S, not in brief |
| Remote sessions WebSocket | Kilo cloud | Remote feature | `packages/opencode/src/kilo-sessions/remote-ws.ts:445` (uses `ws`) | S |
| Session export | `supermassive-black-hole.kiloapps.io` | Gateway provider + free model + personal org | `eligibility.ts` | S |
| Share | `opncd.ai` or `enterprise.url` | Share action, `KILO_AUTO_SHARE` | `KILO_DISABLE_SHARE` (`share-next.ts:23`) | S |
| PR link poller | `api.github.com`, GitLab host, `api.bitbucket.org` | Sessions with a linked PR | `packages/opencode/src/kilo-sessions/pr-link-poller.ts:168,216` | S, not in brief |
| models.dev | `models.dev` | Startup + hourly, provider list | `KILO_DISABLE_MODELS_FETCH`, `KILO_MODELS_URL`, `KILO_MODELS_PATH` | M |
| Connectivity probe | `kilo.ai`, `example.com`, `cloudflare.com` | Provider call fails with a network error | none (`packages/opencode/src/session/network.ts:37`); `offlineGuard` probes the provider base URL | S |
| Update check | `registry.npmjs.org`, `formulae.brew.sh`, `raw.githubusercontent.com` | TUI only (`packages/opencode/src/cli/cmd/tui.ts:454`); not reached by `serve` | `KILO_DISABLE_AUTOUPDATE` | S |
| LSP auto-download | `api.github.com`, `github.com`, `download-cdn.jetbrains.com`, `api.releases.hashicorp.com`, npm | First file touch for a language whose server is missing | `KILO_DISABLE_LSP_DOWNLOAD` | S |
| ripgrep download | `github.com/BurntSushi/ripgrep/releases` | First search when `rg` is not on `PATH` or in Kilo's bin dir; the VSIX does not bundle `rg` | none (`packages/core/src/ripgrep/binary.ts:106`) | S, not in brief |
| Runtime npm installs | `registry.npmjs.org` or `.npmrc` registry | Plugins from config; provider SDK packages not in `BUNDLED_PROVIDERS`; `@kilocode/plugin` for `file://` plugins; LanceDB for indexing | none (`packages/core/src/npm.ts`, `provider/provider.ts:1959`, `kilocode/lancedb.ts:36`) | S, not in brief. `@ai-sdk/openai-compatible` is bundled, so the generic provider needs no install |
| Remote config | `<org>/.well-known/opencode` | `auth` entry of type `wellknown` | `packages/opencode/src/config/config.ts:690` | S |
| Remote skills | Configured `skills.urls` | Config | `packages/core/src/skill/discovery.ts` | S |
| Remote instructions | URLs in `instructions` | Config | `packages/opencode/src/session/instruction.ts` | S |
| MCP remote servers | Configured | Config | none | S |
| Web search | `mcp.exa.ai` (key in query string), `search.parallel.ai` | Tool call | Registered when provider is `kilo` or `opencode-go`, or `KILO_ENABLE_EXA`/`KILO_ENABLE_PARALLEL` (`packages/opencode/src/tool/registry.ts:86`). Permission default is `allow`, not ask (`packages/opencode/src/kilocode/agent/index.ts:173-174`, `agent/agent.ts:234-235`) | S, brief partly wrong on permission default |
| Kilo Exa proxy | Kilo gateway | Web search via Kilo provider | `packages/opencode/src/kilocode/tool/websearch-kilo-exa.ts` | S |
| Web fetch | Any URL from the model | Tool call | Always registered; permission `webfetch` defaults to `allow` | S |
| Clone / repo overview tools | Any git remote | `KILO_EXPERIMENTAL_SCOUT` | Flag | S |
| Built-in auth plugins | `auth.openai.com`, `chatgpt.com` (Codex, incl. `ws`), GitHub Copilot, GitLab, Poe, Cloudflare, Azure, DigitalOcean, Snowflake, x.ai, Cerebras, Modal | Loaded at startup; network on use | `KILO_DISABLE_DEFAULT_PLUGINS` disables all internal plugins (including Kilo auth) | S |
| Atomic Chat plugin | `127.0.0.1:1337` | Discovery | Default plugin | S, loopback (conflicts with acceptance criterion 12) |
| Anaconda Desktop plugin | Loopback ports from Anaconda config | Discovery | Default plugin | S, loopback (criterion 12) |
| Indexing embedders | `api.voyageai.com`, OpenAI, Gemini, Mistral, Ollama `localhost:11434`, Qdrant `localhost:6333`, Kilo gateway | Indexing enabled | Config; extension sets `KILO_DISABLE_CODEBASE_INDEXING` only without a workspace | S |
| Observability | OTLP endpoint | `OTEL_*` env | `packages/core/src/observability.ts` | S |
| Conda probe | none (spawns `conda info --offline`) | Telemetry enabled and `~/.conda/aau_token` exists | Telemetry | S |
| Build-time only | `cdn.sheetjs.com` (xlsx tarball), `models.dev` (snapshot) | `bun install`, `script/build.ts` | n/a | Measured during install |

## Static leads: VS Code extension host (`packages/kilo-vscode/src`)

| Surface | Hosts | Source |
|---|---|---|
| Telemetry re-enable | CLI route above | `extension.ts:138,158`, `services/telemetry/telemetry-proxy.ts:75` |
| Spawn env merge | n/a: `{...process.env, ...extraEnv}` then fixed keys; a user shell can set `KILO_API_URL` etc. unless the hardened keys are applied last | `services/cli-backend/server-manager.ts:104,131-170` |
| Custom provider model list | Configured base URL | `shared/fetch-models.ts:41` (extension host fetch) |
| Speech-to-text | CLI → Kilo gateway, or a custom source URL | `speech-to-text/transcribe.ts`, `catalog.ts` |
| Image generation models | CLI → Kilo gateway | `image-generation/models.ts` |
| Agent Manager avatars | `github.com/<name>.png` | `agent-manager/project/avatar.ts:66` |
| Agent Manager PR status | `gh` CLI child process | `agent-manager/pr-status-bridge.ts`, `PRStatusPoller.ts` |
| Autocomplete | Kilo gateway FIM (via CLI) | `services/autocomplete/` |
| Browser automation | Loopback DevTools only | `services/browser-automation/browser-devtools.ts` |
| MCP OAuth | System browser to the MCP server's auth URL | `services/mcp-auth/service.ts:304`, `kilo-provider/mcp-oauth.ts` |
| External links | `kilo.ai/docs`, `kilo.ai/support`, `kilo.ai/discord`, `app.kilo.ai/credits`, `app.kilo.ai/profile`, `kilo.ai/pricing/kilo-pass`, `blog.kilo.ai/...`, `google.com/chrome` (system browser, not process egress) | webview and `AutocompleteServiceManager.ts:419` |

## Static leads: webview (renderer process, outside any Node guard)

| Surface | Detail | Source |
|---|---|---|
| Remote images | CSP `img-src ${cspSource} data: https:` lets any `https:` image load. Model output rendered as markdown can embed `![](https://host/?data)`, which is an exfiltration channel the in-process guard cannot see | `packages/kilo-vscode/src/webview-html-utils.ts:39` |
| Frames | Browser tab frames are limited to `localhost`/`127.0.0.1`; Agent Manager browser panel to be checked in Phase 2 | `browser-tab/BrowserTabProvider.ts:198` |

## UI audit: cloud-dependent features (first pass)

| Feature | Entry points |
|---|---|
| Marketplace | Sidebar top bar `marketplace` (`webview-ui/src/components/chat/SidebarTopBar.tsx:50`); commands `kilo-code.new.marketplaceButtonClicked`, `kilo-code.new.sidebarTitle.marketplaceButtonClicked`; `MarketplacePanelProvider.ts`; CLI route `/kilocode/marketplace` |
| Profile / account / credits / Kilo Pass | Sidebar `profile` (`SidebarTopBar.tsx:51`); commands `kilo-code.new.profileButtonClicked`, `kilo-code.new.sidebarTitle.profileButtonClicked`; `webview-ui/src/components/profile/` |
| Cloud sessions | `webview-ui/src/components/history/CloudSessionList.tsx`, `src/kilo-provider/handlers/cloud-session.ts` |
| Remote | `src/services/RemoteStatusService.ts`, `/remote/status` |
| Share | Session share actions (CLI share routes) |
| Kilo gateway provider and BYOK cards | `ProvidersTab.tsx`, `ProviderConnectDialog.tsx`, `ProviderSelectDialog.tsx`, `provider-catalog.ts` |
| Autocomplete (Kilo gateway FIM) | `AutocompleteTab.tsx`, autocomplete commands |
| Indexing (gateway embeddings default) | `IndexingTab.tsx` |
| Speech-to-text | `webview-ui/src/components/speech-to-text/` |
| Notifications from Kilo | `/kilo/notifications`, `NotificationsTab.tsx` |
| Anaconda Desktop | `AnacondaDesktopDialog.tsx` |
| Integrated browser | `kilo-code.new.openBrowser` (local only, keep or hide per decision) |

## Differences from the brief's section 3

1. Baseline: latest upstream tag is `v7.8.12`, not `v7.8.9`. The branch is `v7.8.12` plus one merged PR, so it is not exactly a tag.
2. New gateway host `ai-gateway.kilo.ai` with its own env var `KILO_AI_GATEWAY_URL` (added between v7.8.8 and v7.8.12).
3. Marketplace is also a CLI route that the CLI fetches from `api.kilo.ai`; disabling only the extension UI leaves it reachable.
4. Not in the brief: PR link poller (GitHub/GitLab/Bitbucket APIs), cloud agent origin, ripgrep runtime download, runtime npm installs (plugins, unbundled provider SDKs, LanceDB), remote config/skills/instructions, internal auth plugins (Codex uses `ws`), Atomic Chat and Anaconda loopback discovery, Agent Manager GitHub avatars, webview `img-src https:`.
5. Web search and web fetch permissions default to `allow`, not ask. Web search is also enabled whenever the Kilo provider is selected, independent of the env flags.
6. Update checks run only in the TUI, not in `kilo serve`, so the extension path does not reach them.
7. Telemetry re-enable path confirmed exactly as described.

## Guard feasibility (measured, informs R2)

Probe: patch `net.connect`, `net.createConnection`, `net.Socket.prototype.connect`, `tls.connect`, `globalThis.fetch`, `globalThis.WebSocket`, `Bun.connect`; then exercise each client.

| Client | Node 22 (extension host) | Bun 1.4.2 (CLI) |
|---|---|---|
| `fetch()` after patch | caught (fetch wrapper) | caught (fetch wrapper) |
| `fetch` reference captured before patch | caught (`tls.connect`) | **not caught**: Bun's native fetch does not use `node:net`/`node:tls` |
| `http.get` / `https.get` | caught | caught |
| `ws` package | caught (`tls.connect`) | **not caught**: Bun's `ws` shim bypasses both `node:tls` and `globalThis.WebSocket` |
| `new net.Socket().connect` | caught | caught |
| `Bun.connect` | n/a | property is writable but not configurable: assignment works, `defineProperty` does not. Unused in runtime source |

Consequences: in the extension host, socket-level hooks give near-complete coverage. In the CLI, the guard must install before any module captures `fetch`, and the three `ws` call sites (Codex WebSocket, remote sessions, event service) need either a call-site check or removal. Proxy environment variables were honoured by every CLI request in the capture, which makes an enforcing loopback proxy a strong second layer that also covers proxy-aware child processes (`git`, `curl`, `npm`).
