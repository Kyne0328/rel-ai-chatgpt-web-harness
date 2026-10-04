# Security

## How the ChatGPT connection is secured

Rel.AI supports one ChatGPT transport: **OpenAI Secure MCP Tunnel**. The desktop can supervise a primary tunnel plus additional independent tunnels for other ChatGPT accounts; every tunnel forwards to the same authenticated local MCP service.

The Electron desktop starts the private local MCP service and supervises one bundled OpenAI `tunnel-client` process per configured tunnel. Two credential types have separate responsibilities:

- **OpenAI tunnel runtime API key** — authorizes one `tunnel-client` to operate its configured Secure MCP Tunnel. Electron stores every runtime key through `safeStorage`; the renderer receives only whether a key is configured.
- **Rel.AI local bearer token** — authenticates requests arriving at the private local `/mcp` service. The tunnel client injects this header when forwarding MCP traffic. It is not a ChatGPT credential and is not shown in the normal connection UI.

The local MCP service requires `Authorization: Bearer <REL_AI_MCP_TOKEN>`. A no-auth mode exists only for explicit local testing and is rejected on non-local binds.

Rel.AI does not expose its previous local OAuth authorization server. `/register`, `/authorize`, `/token`, secret-bearing MCP URLs, legacy `/sse`, and legacy `/messages` are not supported connection paths.

### Dashboard and local API access

The desktop dashboard uses a short-lived bootstrap/session flow backed by the local Rel.AI token. Direct API access may use the same bearer token. Dashboard authorization is separate from Secure MCP Tunnel control-plane authentication.

## Project access protections

ChatGPT can work only inside folders you explicitly add as Rel.AI workspaces. Rel.AI applies these protections around that access:

- Workspace roots must be absolute project directories. System roots and common operating-system directories are rejected.
- File operations resolve against the configured workspace root; traversal, absolute-path injection, and symlink escape are blocked.
- Sensitive paths use operation-aware policy. Public trust/configuration files may be readable when content inspection confirms they contain no credential material; private-key and credential-bearing content remains blocked by default.
- `relai_edit` exposes narrow environment-file operations that can manage key names without returning secret values.
- Binary-looking files are rejected by text read and write paths.
- Reads, snapshots, diffs, process output, diagnostic logs, and HTTP request bodies are bounded.
- Exact replacement can use the SHA-256 returned by `relai_read`; stale hashes fail closed.
- Git push is restricted to configured remotes.
- Sensitive staged paths require explicit path-scoped authorization before commit.
- Task-aware diffs can redact sensitive hunks.
- Automatic task baselines distinguish task-owned changes from a worktree that was already dirty.
- Cleanup revalidates file ownership, type, and hash before deletion.
- Patch-shaped edits can require a clean worktree and create a tracked-change backup before application.

## Work sessions stay separate from the connection

The Secure MCP Tunnel carries requests between ChatGPT and Rel.AI, but the connection does not decide which repository task is active. Each new goal gets its own work session and internal `work_id`, keeping edits, checks, review, recovery, and completion attached to that task.

Native MCP `taskId`, Rel.AI `work_id`, and managed-process `processId` are separate technical identifiers. Reconnecting the tunnel cannot merge tasks, repeat an uncertain change, or mark repository work complete.

Validation commands, builds, analyzers, and repository scripts execute code on the configured computer. Only configure repositories you trust ChatGPT and Rel.AI to inspect, execute, and modify.

## Electron renderer and IPC boundary

- The dashboard, setup wizard, and recovery renderer use context isolation with Node integration disabled.
- Setup and recovery pages have strict Content Security Policy and use the restricted `relai-app://renderer` protocol.
- Renderer permissions, downloads, attached webviews, popups, redirects, and unexpected navigation are denied.
- Every privileged IPC channel checks the sending `BrowserWindow`.
- Clipboard payloads are bounded and NUL characters are removed.
- The tunnel runtime API key is write-only after storage. Blank settings saves preserve it; a nonblank value replaces it.
- Passive connection status sent to renderers contains no runtime API key or local bearer credential.

## Application update boundary

- Update discovery and downloads run only in Electron main.
- Update IPC accepts only the secured dashboard sender.
- Installed Windows builds use the configured GitHub Releases provider. Portable and development builds do not claim automatic update support.
- Candidate metadata must describe a strictly formatted newer stable version; prereleases, same-version candidates, downgrades, and malformed metadata fail closed.
- Downloaded version metadata must match the advertised version before installation is enabled.
- Downloads and restart-to-install are explicit user actions.
- Restart-to-install is blocked while Rel.AI tool calls are active.
- Runtime logs are bounded and sanitized before persistence or export.
- Published artifacts are covered by SHA-256 checksums and GitHub attestations; Electron fuses reduce executable and preload attack surface.

## Bundled tunnel-client boundary

The release pins one reviewed OpenAI `tunnel-client` version and platform artifact in `vendor/tunnel-client/manifest.json`. Fetch and package verification fail closed on size or SHA-256 mismatch. The packaged executable is outside ASAR and is started only by Electron main with the configured tunnel ID, control-plane key, local MCP URL, and local authorization header.

Tunnel-client upgrades are release changes. Rel.AI does not accept an arbitrary tunnel executable path from the renderer or silently replace the bundled binary at runtime.

## Desktop lifecycle boundary

- Lifecycle state and startup settings are owned by Electron main.
- `desktop-lifecycle.json` contains no tunnel runtime API key, local bearer token, workspace contents, or repository credentials.
- Installed Windows startup registration targets the packaged executable with `--background`; portable and development builds do not register startup entries.
- Unclean-exit detection is diagnostic metadata only and never authorizes destructive repository recovery.

## What you still need to trust

Rel.AI is a trusted local ChatGPT harness, not a sandbox.

- Protect the OpenAI tunnel runtime API key and the local Rel.AI bearer token. Replace either credential if it is exposed.
- Anyone with operating-system access sufficient to read process memory, user credentials, or protected application state may be able to interfere with the local harness.
- Repository-defined commands execute with the permissions of the Rel.AI process.
- ChatGPT can modify non-sensitive files inside configured workspaces through authorized tools.
- Git push publishes to allowlisted remotes; review the task diff before committing or pushing.

## Tool workflow

```text
inspect:  relai_snapshot -> relai_read
change:   relai_edit
validate: relai_validate action=checks
review:   relai_changes action=diff / relai_work action=status
recover:  relai_changes restore/reset/tidy actions
publish:  relai_publish action=commit -> relai_publish action=push
```

Only add projects you trust ChatGPT and Rel.AI to inspect, run, and modify.
