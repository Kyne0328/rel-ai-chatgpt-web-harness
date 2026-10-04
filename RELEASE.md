# Release process

Rel.AI MCP uses a strict release path so a tag cannot ship mismatched versions, protocol behavior, tunnel-client bytes, documentation, or runtime files.

## 1. Validate source

```bash
npm run release:check
npm run test:all
npm run knip:production
npm run audit:production
npm run audit:packaging
npm run benchmark:observability
```

`release:check` is the authoritative finalized-release metadata gate. It verifies every synchronized version surface, the current changelog entry, release manifest, generated color assets, and current public tool-manifest metadata. `test:all` handles normal development validation without duplicating finalized release metadata checks. CI and packaging use Node.js 26. Live npm audits block confirmed high/critical findings, but a temporary npm advisory-service outage is reported rather than turning an otherwise reproducible release into a false failure.

When working through Rel.AI itself, use the task-aware validation and diff tools so the evidence remains associated with the current work session.

## 2. Verify the MCP contract

The release retains one canonical public tool surface for stdio and private HTTP clients. Its exact size and action contracts come from the current tool registry rather than release documentation.

Required invariants:

- ordinary MCP protocol behavior targets `2026-07-28`;
- HTTP MCP is exposed only at `POST /mcp`;
- local HTTP MCP requires the private bearer token except in explicit local-only test mode;
- removed `/register`, `/authorize`, `/token`, `/sse`, and `/messages` routes remain absent;
- HTTP may retain only the tested stateless `2025-11-25` ChatGPT startup lifecycle (`initialize` and `notifications/initialized`); all ordinary MCP operations remain modern-only;
- long or indeterminate eligible work uses the bounded/background fallback rather than MCP Tasks;
- MCP Events webhook delivery and `completedOperations` fallback preserve terminal completion delivery without polling;
- repository work sessions, fallback operation IDs, and managed processes retain separate identifiers;
- task-scoped calls require the exact `work_id` created by `relai_work action=begin`;
- transport or conversation identity never substitutes for work-session ownership;
- `relai_edit` is the repository file-change surface; and
- publishing actions remain explicit.

MCP Events and fallback delivery are covered by the normal unit and HTTP MCP suites. The remaining `2025-11-25` compatibility is startup-only; ordinary MCP operations must use `2026-07-28`.

## 3. Verify pinned native components

`vendor/tunnel-client/manifest.json` and `vendor/zoekt/manifest.json` pin the reviewed runtime components, provenance, target-specific file sizes, and SHA-256 hashes. `scripts/electron-package.mjs` owns target provisioning: when a required tunnel-client or Zoekt binary is missing or stale, the package command fetches/builds the pinned artifact and then verifies it before Electron Builder runs. CI and local packaging therefore use the same preparation path instead of separate platform setup steps.

The standalone `npm run fetch:tunnel-client`, `npm run verify:tunnel-client`, `npm run fetch:zoekt`, and `npm run verify:zoekt` commands remain available for explicit provenance or cache checks. Packaged verification hashes the selected target binaries again after they are copied into the application.

## 4. Build and verify the desktop package

Windows:

```bash
npm run electron:build:windows
npm run verify:packaged -- --platform win32
npm run test:connector-acceptance
npm run verify:fuses -- --platform win32
```

Linux is built and verified in its native release job with the corresponding Linux platform arguments.

`test:connector-acceptance` launches only the isolated packaged Node backend. It verifies bearer-authenticated MCP discovery, tool/resource contracts, a guarded repository mutation, validation, dashboard history, reconnect persistence, ChatGPT-compatible stateless initialization, and the absence of removed routes. It does not need a production tunnel credential and does not pretend to prove external ChatGPT account state.

## 5. Review breaking changes

Release notes for the Secure MCP Tunnel hard cutover must clearly state that the previous connection transports and local OAuth authorization flow were removed. Historical release-specific behavior belongs in `CHANGELOG.md`; do not preserve obsolete runtime paths only to avoid documenting a breaking change.

## 6. Version and changelog

Use the release helper so version surfaces move together:

```bash
npm run release:bump -- <next-version> --date <YYYY-MM-DD> --no-changelog
```

Then add the dated changelog section and run:

```bash
npm run release:check
```

The synchronized surfaces include the root and Electron package manifests/lockfiles, plugin metadata, Electron status version, release metadata, and changelog. `scripts/release-surfaces.mjs` is the canonical file list shared by bump, consistency-check, and finalize logic so adding a release version surface does not require unrelated hand-maintained lists. The bump helper also regenerates protocol/tool compatibility fields in `release-manifest.json` from the current runtime contract; hashes and tool counts are not copied by hand.

## 7. Package-size and artifact gates

Build final artifacts and enforce the committed size policy:

```bash
npm run electron:dist:windows
npm run electron:size:windows
npm run verify:updater-artifacts
npm run generate:sbom
```

Release publication requires canonical filenames, matching versions, updater SHA-512 integrity, SHA-256 coverage, SBOM generation, and GitHub attestations. Artifact paths are derived from the Electron Builder `artifactName` configuration through `scripts/release-artifacts.mjs`, so changing a package filename does not require duplicating that filename in workflow YAML or tests. The CycloneDX SBOM is generated from `package-lock.json` rather than the mutable installed dependency tree and then extended with every pinned tunnel-client and Zoekt platform artifact from their manifests. Packaging also verifies that every direct Electron packaging dependency installed under `electron/node_modules` matches the exact version resolved by `electron/package-lock.json`, preventing local builds from silently using stale runtime bytes after a dependency upgrade.

## 8. Installed release validation

The release workflow runs installer lifecycle validation only on disposable GitHub-hosted runners after packaging and before publication. Windows installs the immediately previous stable NSIS release, verifies the downloaded asset size and GitHub SHA-256 digest when available, verifies the installed version, writes a user-state sentinel, installs the candidate over the same application identity, confirms state preservation, and runs packaged connector acceptance from the installed application. Linux performs the corresponding DEB install/upgrade check using the stable package identity, verifies the previous asset before execution, validates the installed package version and Chromium sandbox permissions, preserves the user-state sentinel, and runs the same packaged connector acceptance. A first-ever release falls back to fresh-install validation; if a previous stable release exists but its expected upgrade artifact is missing, publication fails rather than silently testing an older release.

These jobs intentionally remain outside `npm test` and normal CI because they execute real installers. macOS remains package-level validation only because there is no Developer ID/notarization identity. The release builder disables certificate auto-discovery, ad-hoc signs the completed `.app`, verifies it with `codesign --verify --deep --strict --verbose=2`, checks nested application/framework executables and framework symlinks, runs `hdiutil verify`, mounts the final DMG, re-verifies the app from the mounted image, compares framework symlink layout, and runs packaged layout, MCP acceptance, and Electron fuse checks against the mounted copy.

## 9. Manual and external release checks

Use a disposable release machine for checks that require external credentials or behavior the repository cannot prove locally:

- Windows uninstall behavior when specifically changed;
- first-run Secure MCP Tunnel configuration;
- real Tunnel ID/runtime API key connection and reconnect after restart;
- real ChatGPT Tunnel integration and one read-only workspace request;
- tool-schema refresh/review after a deliberate schema change;
- macOS Developer ID signing/notarization once signing credentials and policy are introduced; and
- light/dark, narrow-layout, and accessibility review when release-facing UI changed.

Do not run installer lifecycle tests on the developer machine hosting the active Rel.AI connector.

## 10. Publish

Pushing the version commit to `main` triggers `.github/workflows/release.yml`. Preflight first rejects inconsistent release metadata before any platform package is built. The workflow then builds and verifies platform release artifacts. Windows and Linux must additionally pass the disposable fresh-install/upgrade jobs before the combined release can be prepared, attested, and published. If a prior publication attempt created the version tag but not the GitHub release, a rerun may recover only when that tag resolves to the exact current release commit; a tag pointing elsewhere fails closed.

Rel.AI-owned Windows artifacts currently disable certificate auto-discovery and are covered by SHA-256 plus GitHub attestations. macOS artifacts also disable certificate auto-discovery; they are ad-hoc signed only, are not notarized, and are explicitly labeled that way in GitHub release notes. Users should copy the app to Applications, attempt to open it once, then use System Settings → Privacy & Security → Open Anyway when Gatekeeper blocks the unnotarized app. The packaged OpenAI tunnel-client bytes must match the reviewed provenance manifest.

Scan the installer, portable executable, unpacked Rel.AI executable, and extracted tunnel client as separate samples before broad distribution. A malware/Trojan classification blocks publication pending investigation. See `docs/ANTIVIRUS_FALSE_POSITIVES.md` for component-level handling.

A release-preparation commit must not be pushed until the automated gates and the manual/external checks required for that candidate are complete.
