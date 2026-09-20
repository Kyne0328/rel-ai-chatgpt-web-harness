# Installer test safety

## Root cause

The former `test:installed` command built an NSIS package with the production Electron identity (`com.relai.mcp` / `Rel.AI MCP`), installed it silently, and executed the generated uninstaller during teardown. The custom temporary destination isolated files but did not isolate the Windows installer product identity. Windows could therefore treat the test package as the installed production application, and teardown could remove or replace the real installation.

## Safe commands

The following commands do not install or uninstall Rel.AI MCP:

| Command | Purpose | Host safety |
| --- | --- | --- |
| `npm test` | Full source test suite | Safe for normal development |
| `npm run test:all` | Build CSS, static checks, lint, typecheck, release consistency, and source tests | Safe for normal development |
| `npm run electron:build` | Build an unpacked application directory | Does not register or install the app; refuses to overwrite an active unpacked controller |
| `npm run verify:packaged` | Verify files in the unpacked application directory | Read-only |
| `npm run test:connector-acceptance` | Launch the isolated packaged Node backend and exercise OAuth/MCP | Does not launch or install Electron and uses temporary state |
| `npm run electron:dist` | Produce installer and portable artifacts | Builds in OS-temporary staging, never executes artifacts, and promotes completed output without replacing files used by an active controller or editor |

Rel.AI treats configuration, tunnel credentials, workspace state, task/history data, and user preferences as user-owned state. The Windows packaging config explicitly keeps `deleteAppDataOnUninstall: false`, and the pinned electron-builder assisted-uninstaller template deletes Electron app data only when its delete-data build define is enabled or when the uninstaller is deliberately invoked with `--delete-app-data`. Rel.AI does neither during normal install, upgrade, or uninstall flows, so ordinary binary removal preserves user data. A future UI for full data removal must remain a separate explicit action rather than an implicit side effect of uninstalling or upgrading binaries.

No ordinary package script installs, upgrades, repairs, or uninstalls a Windows application. Packaging is centralized in `scripts/electron-package.mjs`, which always uses `--publish never`, never launches generated executables, and invokes the active-controller guard before writing build output. Release builds are staged outside the repository so VS Code, antivirus, or Explorer handles cannot corrupt Electron Builder. Completed artifacts are promoted into `dist`; `dist/current-unpacked.json` identifies the authoritative unpacked application when an older unpacked directory must be preserved. The Electron app writes `~/.rel-ai-mcp/controller-runtime.json` with its PID and runtime paths; stale markers are ignored, while a live controller under the requested output tree blocks cleanup and packaging. The removed `test:installed` command must not be restored to `test`, `test:all`, `check`, or normal CI.

## Installer lifecycle validation

Real install and upgrade validation runs only in dedicated disposable GitHub-hosted release jobs through `scripts/validate-installed-release.mjs`. The harness is deliberately not exposed as an npm package script and refuses to run unless `GITHUB_ACTIONS=true` and `REL_AI_RELEASE_INSTALL_TEST=1`. Windows additionally uses `scripts/installer-test-safety.mjs` and requires `REL_AI_INSTALLER_TEST_ISOLATED=1`; production installer identity is allowed only with `REL_AI_ALLOW_PRODUCTION_INSTALLER_TEST=1` on that disposable runner.

The release harness validates the actual production identity because side-by-side test identities cannot prove that an existing user installation upgrades in place. Before doing that, it refuses to continue when a production installation is already present. It resolves the immediately previous stable release, requires that release's canonical platform installer/package, verifies its recorded size and GitHub SHA-256 digest when available, installs it, writes a user-state sentinel, installs the current artifact over it, verifies the installed version and location, confirms the sentinel survived, and runs packaged connector acceptance from the installed application. Only a repository with no earlier stable release falls back to fresh-install-only validation; a missing previous-release artifact fails closed. Linux performs the equivalent DEB package/version and user-state checks and also verifies the installed Chromium sandbox ownership and setuid bit.

The safety requirements are:

1. installer execution is restricted to disposable GitHub Actions release jobs with explicit opt-in;
2. Windows uses a unique run ID, test-owned temporary root, and ownership marker;
3. destructive cleanup is constrained beneath that owned temporary root;
4. empty, root, home, production, and system paths are rejected;
5. existing production installations cause the release harness to fail closed rather than modify them;
6. production installer identity is permitted only for the explicit disposable release-validation path; and
7. ordinary development tests and packaging never execute generated installers or uninstallers.

A temporary `/D=<path>` argument alone is not sufficient isolation because installer identity and registry state are independent from the destination directory.

## Recovery after the old defect

If a previous test removed the application, reinstall the current published Rel.AI MCP installer. Before restoring settings, inspect the existing Rel.AI state and configuration directories; reinstalling binaries should not require deleting user configuration. Do not rerun the former installed-app smoke command to diagnose the problem.

## Regression enforcement

`test/installer-test-entrypoints-unit.mjs` locks `deleteAppDataOnUninstall` to `false`, keeps installer execution out of ordinary package scripts, and requires the release-only lifecycle harness to retain its GitHub Actions and explicit opt-in guards. `test/suite-release-build-unit.mjs` verifies production-install detection, path rejection, unique test identities, ownership markers, and cross-run cleanup isolation. The release workflow is the only automated path allowed to execute the production installer identity.
