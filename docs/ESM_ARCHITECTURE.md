# First-party ESM architecture

Rel.AI MCP uses ECMAScript Modules for all first-party application, CLI, server, Electron main-process, renderer, build, release, and test code. The root package and the Electron package both declare `"type": "module"`, and relative first-party imports include explicit file extensions.

## Package and runtime ownership

```text
Root package (ESM)
├── bin/                         CLI, stdio MCP, HTTP MCP, and diagnostics entry points
├── src/                         backend, MCP authorization, tools/resources, telemetry, tasks, processes, and dashboard server
├── scripts/                     build, package, release, and verification programs
├── test/                        ESM unit, integration, contract, and smoke tests
└── electron/ (ESM package)
    ├── main.js                  Electron main process
    ├── preload.cjs              one sandbox-required CommonJS boundary
    ├── renderer/                browser-context ESM renderers and generated CSS
    └── resource-path.js         development/packaged ESM resource resolution
```

`src/packageMetadata.js` owns root package metadata and package-relative paths. Runtime code reads `package.json` through that module rather than JSON import attributes or CommonJS loaders. `electron/resource-path.js` owns development and packaged resource resolution and converts filesystem paths to file URLs before importing backend modules.

## Electron preload boundary

| File | Technical necessity | External constraint | Regression coverage | Removal condition |
|---|---|---|---|---|
| `electron/preload.cjs` | A sandboxed preload must expose constrained `contextBridge` APIs before renderer code runs. | Electron sandboxed preloads currently use a limited CommonJS environment and do not support ESM imports. | `test/esm-hard-cutover-unit.mjs`, `test/suite-desktop-runtime-unit.mjs`, `test/dashboard-window-unit.mjs`, `test/suite-runtime-core-unit.mjs`, and Electron smoke tests | Convert only when the supported Electron runtime can execute a sandboxed ESM preload without disabling sandboxing, context isolation, or existing IPC constraints. |

This boundary may call `require('electron')` once. It does not import first-party CommonJS code, duplicate an ESM implementation, or provide a general compatibility loader. `--relai-preload-surface=dashboard|application` selects the minimum bridge for each window.

Electron main remains ESM. `contextIsolation` and `sandbox` remain enabled, `nodeIntegration` remains disabled, and IPC handlers continue to validate their sender and payload.

## Generated color assets

`src/ui/colorTokens.mjs` is a build-time manifest only:

```text
src/ui/colorTokens.mjs
→ scripts/generate-color-tokens.mjs
→ src/ui/styles/color-tokens.css
→ electron/renderer/color-tokens.css
→ docs/color-system-reference.svg
```

Use `npm run verify:color-tokens` before generation, testing, release checks, or packaging. It runs the generator in non-mutating `--check` mode and fails when a committed generated asset is stale. Use `npm run generate:color-tokens` only to intentionally restore or update generated output after changing the manifest. `test/suite-dashboard-ui-unit.mjs` proves the fail, restore, and pass sequence.

Runtime UI code must not import the manifest. The packaged application contains the generated CSS assets but not a CommonJS color bridge.

## Startup canvas ownership

`electron/startup-background.js` owns the neutral BrowserWindow pre-render canvas color. Main-process window construction applies that value before renderer CSS loads so development and packaged windows do not flash Electron's default white canvas. This deliberately small startup value does not duplicate the full theme or import the build-time color manifest.

## Removed compatibility behavior

The ESM cutover removes:

- first-party `require()`, `module.exports`, `exports.*`, and `createRequire` loaders outside the documented preload;
- duplicate preload implementations;
- the removed CommonJS color module and any color-manifest bridge;
- dashboard path aliases such as `#reference`, `#settings/connector`, `#settings/desktop`, and `#settings/dashboard`.

Only canonical dashboard routes are supported. Removed or unknown routes fall back to Overview instead of silently redirecting.

## Contributor requirements

- Node.js `>=22.13.0`; CI covers the Node.js 22 and 24 LTS lines.
- npm lockfiles are authoritative for the root and Electron packages.
- Electron is owned by `electron/package.json`; current source targets Electron 43.
- Use explicit `.js` extensions for relative ESM imports.
- Prefer static imports. Use `import()` only for a real runtime boundary such as loading packaged resources by file URL.
- Do not add `createRequire`, compatibility re-exports, duplicate `.cjs` implementations, or extensionless first-party imports.
- Run `node test/esm-hard-cutover-unit.mjs`, `npm run verify:color-tokens`, and `npm run test:all` before proposing a release change.

## Build and release workflow

1. Work from a clean branch or isolated worktree and classify existing changes before editing.
2. Run `npm ci` and `npm ci --prefix electron`.
3. Run `npm run verify:color-tokens` before any generation step.
4. Run `npm run test:all` and `npm run release:check`.
5. Fetch and verify the platform OpenAI tunnel-client artifact.
6. Build and inspect the unpacked Electron application.
7. Run packaged backend connector acceptance.
8. Build the installer and portable executable from the exact release commit.
9. Validate the installed application and active ChatGPT connector manually where the environment cannot safely automate those operations.
10. Tag only after the working tree is clean and every mandatory release gate passes.

## Connector upgrade

1. Build or install the candidate from the exact release commit.
2. Stop the old Rel.AI process without terminating unrelated tasks or deleting local configuration.
3. Start the candidate and confirm its reported application version, protocol version, tool-surface version, and tool count.
4. Reconnect the ChatGPT integration to the configured OpenAI Secure MCP Tunnel and confirm the tunnel reports Connected.
5. Execute a complete task: start, resolve a workspace, read source, perform a guarded write, validate, inspect activity, complete, then verify history after reconnect.
6. Keep the previous executable available until this workflow passes.

## Rollback

- Stop the candidate process.
- Restore the prior installed release or executable without modifying workspace repositories.
- Restore the prior application version and reconnect it to the intended tunnel if connection metadata changed.
- Revert release commits in reverse order rather than mixing ESM and CommonJS implementations.
- Never restore deleted compatibility wrappers as an emergency fallback. If the preload boundary blocks a release, retain only the tested `preload.cjs` boundary and report the release blocker.
