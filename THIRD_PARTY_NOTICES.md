# Third-Party Notices

Rel.AI MCP is distributed under the Apache License, Version 2.0, but it includes and depends on third-party software that remains governed by its own license terms.

This document supplements the project [NOTICE](NOTICE). It does not replace license files shipped with individual third-party components and does not relicense third-party software.

## Major bundled components

### .NET NativeAOT runtime

The Windows x64 process-ownership companion includes the .NET NativeAOT runtime
10.0.12, compiled with .NET SDK 10.0.401 from the shared controller source.

- Upstream: <https://github.com/dotnet/runtime>
- License: MIT, Copyright (c) .NET Foundation and Contributors
- License and upstream notices: `src/windows-process-job-licenses/`
- Build configuration and provenance: `src/windows-process-job-host.csproj` and
  `src/windows-process-job-host.manifest.json`

### OpenAI tunnel-client

Rel.AI bundles a pinned build of `openai/tunnel-client` for the supported Secure MCP Tunnel connection.

- Upstream: <https://github.com/openai/tunnel-client>
- Pinned release: `v0.0.15`
- License recorded by Rel.AI: Apache-2.0
- Reproducibility metadata: `vendor/tunnel-client/manifest.json`

### Zoekt

Rel.AI bundles platform builds of Sourcegraph Zoekt for local repository search.

- Upstream: <https://github.com/sourcegraph/zoekt>
- Pinned source commit: `c4d8f3537f7a67423835d8cf6b0e1d13e68e0b4c`
- License: Apache-2.0
- License text: `vendor/zoekt/LICENSE`
- Reproducibility metadata: `vendor/zoekt/manifest.json`

### Tree-sitter grammar WASM artifacts

Rel.AI ships selected Tree-sitter grammar WASM artifacts primarily sourced through `tree-sitter-wasm` 2.0.1. QL, SystemRDL, and TLA+ are supplemental WASM builds from `tree-sitter-ql` 1.0.0, `tree-sitter-systemrdl` 0.8.0, and `@tlaplus/tree-sitter-tlaplus` 1.5.0 respectively. These packages are MIT-licensed. Each grammar artifact retains the license of its upstream grammar project. Package names, versions/commits, checksums, and source metadata are recorded in `vendor/tree-sitter/manifest.json`.

### Electron, Chromium, Node.js packages, and runtime dependencies

The desktop application and local runtime include Electron/Chromium and npm dependencies listed in the repository manifests and lockfiles. Those packages remain under their respective upstream licenses. Packaged dependency directories retain their included license and notice files where supplied by the upstream package.

Rel.AI release automation also produces software-bill-of-materials (SBOM) metadata for release artifacts so the dependency set can be inspected for a particular build.

## Where to find license information

For a source checkout, review:

- `LICENSE` and `NOTICE` for Rel.AI itself;
- `package.json`, `package-lock.json`, `electron/package.json`, and `electron/package-lock.json` for JavaScript/Electron dependencies;
- license/notice files inside the relevant `node_modules` packages;
- `vendor/tunnel-client/manifest.json`;
- `vendor/zoekt/LICENSE` and `vendor/zoekt/manifest.json`; and
- `vendor/tree-sitter/manifest.json` for grammar provenance.

For an official release, also review the published SBOM/provenance artifacts when available.

If an upstream component's license or notice conflicts with this summary, the upstream license or notice controls for that component.
