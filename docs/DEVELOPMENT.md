# Rel.AI MCP Development Guide

This document owns source development, build, test, packaging, and local protocol details. Installed-app instructions belong in `README.md`, `docs/ONE_CLICK_SETUP.md`, and `docs/CONNECTING_TO_CHATGPT.md`.

## Supported toolchain

- Node.js 26
- npm 12
- Electron and MCP versions pinned by the repository manifests
- the pinned OpenAI tunnel-client artifact for the target platform

The root package and Electron package have separate lockfiles. Keep both synchronized when dependencies change.

## Install source dependencies

```powershell
npm ci --ignore-scripts
npm ci --prefix electron
```

Electron packaging automatically fetches the pinned OpenAI tunnel client when the target-platform binary is absent, then verifies its size and SHA-256 before packaging. You can also prefetch and verify it explicitly:

```powershell
npm run fetch:tunnel-client
npm run verify:tunnel-client
```

## Run from source

```powershell
npm run electron:dev
```

The desktop application owns normal startup. Direct HTTP entry points are maintained for development, protocol testing, and packaged-runtime verification only.

```powershell
npm run start:http
```

The default loopback service commonly uses `http://127.0.0.1:3333`. Health and dashboard routes are development diagnostics, not user setup steps.

## Frontend build and generated assets

The routine dashboard is built through one Vite pipeline:

- the production `public/dashboard.js` entry and its `src/ui/` dependency graph are bundled to `public/dashboard-app.js`; `src/ui/react/main.js` is also retained as `public/dashboard-react.js` for focused runtime probes, with lazy chunks under `public/dashboard-chunks/`;
- Tailwind runs through `@tailwindcss/vite` from `src/ui/styles/app.css` and emits `public/dashboard.css`.

Build the production assets with:

```powershell
npm run build:frontend
```

For browser development with React Fast Refresh and CSS HMR, run the HTTP backend with `REL_AI_MCP_TOKEN` set, then start Vite with the same token:

```powershell
npm run dev:frontend
```

Open `http://127.0.0.1:5173/dashboard.dev.html`. Vite performs a local auth bootstrap through the existing dashboard endpoint, keeps the token server-side, and proxies dashboard API/SSE/Monaco requests to `REL_AI_FRONTEND_BACKEND` (default `http://127.0.0.1:3333`). Use `npm run watch:frontend` when a filesystem build watcher is needed instead of the HMR server.

Color tokens are generated for dashboard, Electron, and documentation surfaces:

```powershell
npm run generate:color-tokens
npm run verify:color-tokens
```

`npm run verify:generated` rebuilds the Vite dashboard into a temporary output and compares it byte-for-byte with the tracked generated assets. Do not hand-edit `public/dashboard-app.js`, `public/dashboard-react.js`, `public/dashboard.css`, `public/dashboard-chunks/`, or other Vite output.

## Validation

Run the smallest checks that prove the change, then the complete gate before release work.

```powershell
npm run check
npm run lint
npm run typecheck
npm run knip:dependencies
node test/run-tests.mjs
```

Complete verification:

```powershell
npm test
```

Tests are risk controls. Prefer the smallest non-overlapping set that protects business behavior, security, validation, transactions or concurrency, data integrity, external protocol compatibility, or a meaningful release contract.

For frontend work, choose tests by ownership: store/SSE/router/model tests for data semantics, dashboard smoke/integration tests for wiring, browser acceptance for real interaction/layout behavior, custom-chrome tests for Electron window integration, `code-editor-browser.mjs` for Monaco/Changes behavior, and recovery-window tests for the independent recovery boundary. Do not preserve tests whose only purpose was to lock obsolete imperative renderer structure.

## Dashboard architecture

The dashboard runtime is intentionally split by ownership:

- `src/http/dashboard.js` emits a minimal HTML shell plus initial dashboard JSON and owns the authenticated dashboard/API/SSE server boundary.
- `public/dashboard.js` is the browser coordinator for startup, authoritative refresh/recovery, Electron status, hash-router initialization, and SSE-to-store delivery. Do not add feature markup there.
- `src/ui/store.js` is canonical revision-aware dashboard client state. Aggregate snapshots replace state; typed live events update their owned domain only.
- `src/ui/events.js` owns the one dashboard `EventSource`, reconnection/backoff, visibility restart, and typed event delivery.
- `src/ui/react/main.js` owns the React application shell, route registration and route-body rendering, page identity/focus/announcements, shared shell chrome, command palette, recovery/dashboard state presentation, overlays/toasts, and store provider.
- `src/ui/navigation-catalog.js` owns route and navigation metadata.
- `src/ui/route-policy.js` owns route normalization/allowed parameters; `src/ui/router.js` owns hash navigation state, route parameter helpers, unsaved-change protection, and route-change dispatch.
- `src/ui/features/` owns feature-local React components, models/helpers, forms, and styles.
- `src/ui/components/` owns controls and behavior that are actually reused across features.
- `src/ui/styles/app.css` is the CSS source entry; its imports are the current list of feature/shared style inputs.

Backend projection stays backend-owned. Do not move task completion, authorization, process lifecycle, connection authority, or workspace truth into React presentation state.

Use local React state for unsaved form values and other UI-only state. Put canonical dashboard data in `src/ui/store.js`, and consume only the slices a feature actually needs when possible. Do not open feature-specific SSE connections.

Keep route metadata centralized. Compatibility redirects may remain in `route-policy.js`, but removed routes must not return as visible destinations.

### Adding or changing a dashboard feature

1. Put the route component and feature-only logic under the owning `src/ui/features/<feature>/` directory.
2. Keep feature-specific CSS beside that feature and import it from `src/ui/styles/app.css`.
3. Register a new top-level React route in `src/ui/react/main.js` only when the route is real and present in the navigation/route policy.
4. Reuse `src/ui/components/` only when a stable behavior is shared by at least two features; do not create abstractions for anticipated reuse.
5. Keep unsaved form state local unless another feature or the backend truly owns it.
6. Use the constrained `window.relaiDesktop` bridge for desktop-only authority; never import Electron into dashboard renderer code.
7. Add the smallest regression test at the failed ownership boundary, then run the relevant browser/Electron acceptance test when behavior crosses those boundaries.
8. Rebuild generated frontend assets before committing source changes that affect them.

## Electron architecture

- `electron/main.js` is the thin Electron composition root; it injects Electron capabilities into `electron/desktop-host.js` and starts the host.
- `electron/desktop-host.js` owns desktop lifecycle, windows, tray, updater, safeStorage-backed credentials, notifications, OS integration, and utility-process supervision. Rel.AI analytics, onboarding state transitions, and task-code repository operations stay behind the service utility-process boundary.
- `electron/renderer/wizard.html` and `wizard.js` own first-run and connection-recovery editing.
- `electron/recovery-window.js` and the status renderer remain independent of the React dashboard so recovery still works when the routine dashboard is unavailable.
- `electron/preload.cjs` exposes narrow, surface-specific bridges. The dashboard uses `window.relaiDesktop`; application/recovery renderers use `window.electronAPI`.
- `electron/ipc-handlers.js` and dashboard-specific IPC handlers validate renderer requests and sender ownership.
- the React dashboard is the routine application surface; the status window is recovery-only.

The wizard owns the minimal installed-app connection setup: Tunnel ID, write-only runtime API key, optional advanced local port, and a single action to start the secure connection.

Developer-only file paths, commands, and diagnostic URLs must not appear in that flow.

## Configuration

Repository development may create or inspect the application’s JSON configuration and environment-backed secrets. Production UI must use secured Electron IPC and must not instruct users to edit those files directly.

Useful development commands include:

```powershell
npm run init-config
npm run workspace:add
```

Rel.AI discovers validation commands from the project's current manifests. Use `relai_validate` for explicit one-off checks and `relai_exec` for other one-shot commands. Durable work can run until it exits or is explicitly cancelled; taskless work retains a bounded safety timeout. Command aliases are not stored in Rel.AI configuration.

## Packaging

Build unpacked applications:

```powershell
npm run electron:build:windows
npm run electron:build:linux
```

Build release artifacts:

```powershell
npm run electron:dist:windows
npm run electron:dist:linux
```

Verify package contents and budgets:

```powershell
npm run audit:packaging
npm run verify:packaged
npm run verify:fuses
npm run electron:size:windows
npm run electron:size:linux
```

Electron packaging runs the same Vite production build before electron-builder, so packaged `public/dashboard-app.js`, `public/dashboard-react.js`, `public/dashboard.css`, and dashboard chunks must come from the current dashboard/React/CSS sources rather than manual generated-asset edits.

Electron runtime resources are fail-closed against packaging drift. Runtime roots listed by the root package (`src/`, `bin/`, `public/`, and `skills/`) are copied as complete trees instead of extension allowlists. `examples/` and `types/` are the explicit non-Electron package roots. `test/electron-launcher-smoke.mjs` requires every runtime root to have an Electron resource mapping, and `scripts/verify-packaged-app.mjs` recursively compares the built artifact's file list and SHA-256 content with source. Adding a new root runtime directory therefore fails verification until it is packaged or deliberately classified as non-Electron.

## Release validation

```powershell
npm run release:check
npm run test:release
npm run verify:updater-artifacts
```

Release publication, signing status, checksums, updater metadata, and artifact policy are documented in the release and security documents. Do not publish from an unverified dirty tree.

## Public product-path scanner

`test/suite-desktop-runtime-unit.mjs` protects the installed-app path from developer-only setup language. Add new public documents or visible connection copy to its declared surface list when appropriate.

The scanner intentionally excludes this development guide and other internal engineering documents.

### ChatGPT setup review note

Treat generic claims that Rel.AI's Secure MCP Tunnel setup must move to **Settings / Workspace settings → Apps → Create** as stale review evidence unless the actual Tunnel setup flow has been revalidated against the shipped ChatGPT UI. Rel.AI's supported product contract is the tested **Tunnel + No authentication** flow in `docs/CONNECTING_TO_CHATGPT.md` and the current dashboard handoff. Do not file an onboarding defect solely because generic OpenAI Apps documentation uses different navigation labels or because the implementation uses the existing ChatGPT connector setup route.

## Engineering principles

- Use DRY, KISS, and YAGNI.
- Prefer direct imports for stable stateless utilities.
- Inject only real runtime boundaries.
- Keep factories limited to state, resources, framework objects, or external clients.
- Consolidate each task against all earlier changes before moving forward.
- Preserve existing staged and user-authored work.
- Verify generated output after source changes.
- Do not commit release artifacts or secrets.

## Related documents

- `docs/ARCHITECTURE.md`
- `docs/DESKTOP_UX_ARCHITECTURE.md`
- `docs/MCP_PROTOCOL_POLICY.md`
- `docs/PACKAGE_MANAGEMENT.md`
- `RELEASE.md`
- `docs/SECURITY.md`
- `CONTRIBUTING.md`
