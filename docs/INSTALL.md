# Installing the restricted-egress extension (IT-managed rollout)

Users install one VSIX and nothing else: no proxy settings, no firewall changes. The allowlist and the extension identity are fixed in the build, and so is the provider if the build names one (see `docs/HARDENING.md`).

## 1. Get a build

Run the `hardening-vsix` workflow (Actions → hardening-vsix → Run workflow, or push a `hardened-v*` tag). Without configuration the build uses the committed `hardening.config.json` (`{}`): loopback only, no preconfigured provider, so users can reach an LLM on their own machine (Ollama, LM Studio, ...) and nothing else. To allow more, store a build config as the repository secret `HARDENING_CONFIG` (the whole JSON file). Every key is optional; to reach an LLM server on the network the minimum is:

```json
{ "allow": { "app": [{ "host": "llm.internal.example" }] } }
```

Add `"provider": { "baseURL": "https://llm.internal.example/v1" }` only if you want it preselected.

The `vsix` artifact holds one VSIX per platform and `SHA256SUMS`:

| VSIX | Machines |
|---|---|
| `kilo-vscode-win32-x64.vsix` | Windows x64 |
| `kilo-vscode-win32-arm64.vsix` | Windows on ARM |
| `kilo-vscode-darwin-arm64.vsix` | Apple silicon Macs |
| `kilo-vscode-darwin-x64.vsix` | Intel Macs |
| `kilo-vscode-linux-x64.vsix` | Linux x64 (glibc) |
| `kilo-vscode-linux-arm64.vsix` | Linux arm64 (glibc) |
| `kilo-vscode-alpine-x64.vsix` | Alpine / musl x64 |
| `kilo-vscode-alpine-arm64.vsix` | Alpine / musl arm64 (needs `rg` installed: no upstream ripgrep build for this target) |

Verify before distributing:

```bash
sha256sum --check SHA256SUMS          # Linux
shasum -a 256 --check SHA256SUMS      # macOS
```

```powershell
Get-FileHash .\kilo-vscode-win32-x64.vsix -Algorithm SHA256   # compare with SHA256SUMS
```

## 2. Install

Per machine, as the user who runs VS Code:

```bash
code --install-extension /path/to/kilo-vscode-<platform>.vsix
```

Updates install the same way: a VSIX with a higher version replaces the installed one. For fleet rollout, run that command from your software-distribution tool (Intune, SCCM, Jamf, Ansible, ...) in the user's context after VS Code is installed.

The extension installs beside upstream Kilo Code if a user also has it. They share no settings, commands, credentials or session data: the build uses its own extension ID, setting namespace and data directory.

## 3. Updates and the VS Code Marketplace

The build's extension ID (`<publisher>.<name>` from the build config) is not published on the VS Code Marketplace, so VS Code finds no Marketplace update for it. Anyone could later publish an extension under the same ID, and VS Code might then offer it as an update. Two ways to close that:

- Register the publisher ID on the Marketplace (and on Open VSX for VS Code forks) without publishing anything, so nobody else can use it.
- Restrict installable extensions with the VS Code `AllowedExtensions` policy (`extensions.allowed` setting, VS Code 1.96 and later), listing this extension's ID and anything else your users need. See [Manage extensions in enterprise environments](https://code.visualstudio.com/docs/enterprise/extensions). Not verified here: whether that policy also governs `--install-extension` from a VSIX file; check the current VS Code documentation before relying on it.

## 4. What users see

- Users add an OpenAI-compatible provider in the extension's provider settings. Its base URL must be on loopback or the allowlist; anything else is rejected with a message listing the allowed hosts. If the build config names a provider, it is preselected and users can add models to it.
- There is no marketplace, Kilo account, cloud history, credits, sharing or remote control.
- Blocked network attempts are logged locally in `<data>/log/egress-denied.log`, where `<data>` is `$XDG_DATA_HOME/<name>` or `~/.local/share/<name>` (the same path on Windows and macOS, under the user's home).
- On Linux (bubblewrap ships in the VSIX) and macOS, commands the agent runs are sandboxed. On Windows they are limited by the allowlist proxy only; tools that ignore proxy settings are not covered (see `docs/HARDENING.md`, Gaps).

## 5. Support checklist

| Symptom | Check |
|---|---|
| "Network access to X is blocked" | X is not on the allowlist. Changing it means a new build: update `HARDENING_CONFIG` and rerun the workflow |
| Provider unreachable | The provider host is reachable from the machine and its TLS certificate chains to a CA in the OS trust store (the CLI uses the system store) |
| Search in the codebase fails with "ripgrep (rg) was not found" | Only on `alpine-arm64`: install `ripgrep` from the distribution |
| Indexing does not start | Indexing needs the `ollama` or `openai-compatible` embedder and a Qdrant vector store on allowlisted hosts; the CLI reports a config warning naming the field it rejected |
