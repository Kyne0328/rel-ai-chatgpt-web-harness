# Package Management Policy

Rel AI MCP uses npm 12 on Node.js 26.8.2. `.node-version` is the canonical Node pin and `packageManager` in the root manifest is the canonical npm pin; CI and release workflows consume those declarations instead of floating on a Node major.

## Canonical installation

```bash
npm ci --ignore-scripts
npm ci --prefix electron
```

The root service and Electron packaging project currently retain separate manifests and lockfiles. This is deliberate for the 0.23 release line: release-version tooling, electron-builder dependency discovery, and packaged-resource ownership already depend on the isolated Electron project.

A workspace conversion is deferred until a dedicated proof branch demonstrates all of the following:

- one `npm ci` produces the exact root and Electron dependency trees;
- release versioning updates both package identities without manual synchronization;
- electron-builder resolves production and development dependencies correctly;
- packaged connector acceptance, fuse verification, and updater metadata remain unchanged;
- rollback to the previous two-lockfile release can be performed without dependency ambiguity.

Do not introduce pnpm, Yarn, a second root lockfile, or manual lockfile edits. Use package-manager commands and commit both lockfiles whenever either manifest changes. The Electron project owns its own `overrides` because root npm overrides do not cross the separate Electron package boundary.

Dependabot checks both `/` and `/electron` weekly. Compatible minor and patch updates are grouped; major updates remain explicit review items. `.github/workflows/dependency-health.yml` also runs weekly (and on demand) to install both lockfiles, execute the production and packaging advisory gates, and report available updates for both trees.

`web-tree-sitter` is pinned to `0.27.0` and validated against the vendored grammar set under `vendor/tree-sitter/`. Most grammars are sourced from `tree-sitter-wasm` 2.0.1; QL, SystemRDL, and TLA+ are supplemental builds from their recorded npm grammar packages because that bundle does not contain them. Tree-sitter runtime upgrades must refresh the vendored WASM binaries and provenance manifest together and pass `npm run verify:tree-sitter-assets`; do not update the runtime independently of its grammar assets.

The repository compiler uses TypeScript 7, but `typescript-lsp-runtime` intentionally aliases TypeScript 6.0.3 because the current `typescript-language-server` 6.0.0 integration requires the legacy `lib/tsserver.js` entry point. TypeScript 7 removed that entry point, so moving this compatibility runtime to TypeScript 7 requires a language-server migration rather than a package-only update.

## Security gates

- `npm run audit:production` blocks confirmed high-severity runtime findings; npm advisory-service outages are reported but are not build failures.
- `npm run audit:packaging` blocks confirmed high/critical release-tool findings; advisory-service outages are reported separately.
- `npm run knip:dependencies` rejects undeclared or unused direct dependencies.
- CI installs with lockfiles and the exact `.node-version`/`packageManager` toolchain declarations; it does not accept floating Electron, MCP SDK, or updater versions.
- The Electron manifest independently overrides `js-yaml` to the patched `4.3.2` release because its lockfile is isolated from root overrides.
- Moderate advisories inherited through `@midscene/computer` remain visible dependency debt until upstream publishes a compatible fixed `@computer-use`/Jimp chain; they are not represented as fixed by unrelated overrides.

## Runtime configuration

`telemetry.diagnosticsEnabled` controls optional diagnostic traces and defaults to `true`; `telemetry.sampleRatio` accepts a value from `0` through `1`. Minimal maintainer usage reporting is separate from that preference and uses the release's built-in `relaiTelemetry.usageEndpoint`; `REL_AI_MAINTAINER_USAGE_ENDPOINT` is the development/runtime override. Official diagnostic traces use `relaiTelemetry.diagnosticsEndpoint`; `REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT` overrides that endpoint for development. A user-configured `telemetry.endpoint` still affects diagnostic traces only. The usage endpoint accepts a fixed minimal JSON schema and successful reports are locally suppressed for 24 hours. `processEnvironment.allow` is the explicit list of additional parent-process variable names that repository commands may inherit. Command-specific `env` values remain explicit overrides and are never copied into audit or telemetry records.
