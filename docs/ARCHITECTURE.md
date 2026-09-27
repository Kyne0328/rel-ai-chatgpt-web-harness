# Rel.AI ChatGPT Web harness architecture

This document describes Rel.AI as the local agency/runtime harness around ChatGPT Web. MCP is the primary ChatGPT-facing tool transport, but the harness also owns local task state, repository intelligence, validation, Git, processes, memory and skills, observability, desktop lifecycle, and opt-in computer control.

The architecture records current runtime ownership and compatibility boundaries rather than historical connection modes.

## Harness responsibility boundary

| Layer | Owns | Does not own |
| --- | --- | --- |
| ChatGPT Web | Model selection, conversation, reasoning, product-side context, and deciding when to call tools | Local repository state, durable Rel.AI tasks, local process lifecycle, Git state, or host input devices |
| Rel.AI harness | Authorized local tools, work sessions, repository intelligence, edits, commands, validation evidence, Git, managed processes, skills/memory, observability, desktop lifecycle, and opt-in computer control | ChatGPT's hidden reasoning, model runtime, account limits, or conversation storage |
| OpenAI Secure MCP Tunnel | Private transport between ChatGPT and the selected Rel.AI desktop | Repository/task authority, local authorization policy, or completion state |

This separation is intentional: Rel.AI extends ChatGPT with a durable local execution environment without pretending to host or replace the ChatGPT runtime.

## Composition roots

The Rel.AI harness has three executable composition roots plus one external transport service:

| Host | Composition root | Responsibility |
| --- | --- | --- |
| Electron desktop | `electron/main.js` -> `electron/desktop-host.js` | `main.js` is the composition root. The desktop host owns windows, tray, updater, Secure MCP Tunnel supervision, encrypted tunnel credentials, notifications, OS integration, utility-process lifecycle, and shutdown order; Rel.AI business operations execute behind the service utility-process boundary. |
| HTTP MCP service | `bin/rel-ai-mcp-http.js` -> `src/httpServer.ts` | Owns the authenticated local HTTP server, dashboard/API routes, modern and compatible stateless MCP routing, process cleanup, and telemetry lifecycle. |
| Stdio MCP service | `bin/rel-ai-mcp.js` -> `src/server.js` | Owns modern stdio MCP, connection-scoped principal state, native Task routing, process cleanup, and telemetry lifecycle. |
| OpenAI Secure MCP Tunnel | external service + bundled `tunnel-client` | Provides the private transport between ChatGPT and the selected desktop. It does not own repository state or Rel.AI task lifecycle. |

Composition roots construct resource owners. Pure validation, mapping, formatting, catalog, and projection functions are imported directly.

## Dashboard frontend ownership

The routine dashboard is a React application backed by server-owned projections. The current path is:

```text
src/http/dashboard.js
  -> minimal HTML shell + initial dashboard JSON
  -> public/dashboard.js coordinator
  -> src/ui/store.js canonical client state
  -> src/ui/react/main.js React shell + route components
  -> src/ui/features/* feature-local React UI
```

`src/http/dashboard.js` owns authenticated dashboard/API/SSE delivery and the initial read model. It does not generate application navigation or feature markup. Backend projection and lifecycle authority stay in backend modules such as `src/http/dashboardData.js`; React presents those contracts but does not become a second task, connection, process, or workspace authority.

`public/dashboard.js` is the browser coordinator. It initializes the canonical store, mounts the React foundation, connects Electron status when available, owns refresh/recovery coordination, and initializes hash navigation. It must not grow feature-specific rendering logic.

`src/ui/store.js` is the canonical dashboard client state boundary. Aggregate refreshes replace the authoritative read model, while typed SSE deltas update only their owned domain. Live metadata carries a stream ID and per-domain revisions; stale or duplicate revisions are rejected before subscribers are notified. React components consume the store through `useSyncExternalStore`, using feature-specific slice selection where a route does not need the full dashboard state.

`src/ui/events.js` owns the single dashboard `EventSource` lifecycle, reconnect backoff, visibility recovery, typed event parsing, and transport state. Feature components do not open their own SSE connections. `src/ui/router.js` owns canonical hash navigation state, route-parameter helpers, unsaved-change navigation protection, and `relai:route-change` dispatch. `src/ui/navigation-catalog.js` remains the route/navigation metadata source.

`src/ui/react/main.js` owns the persistent application shell, navigation, title bar integration, command palette, route selection and route-body rendering, route-heading focus, route-mounted announcements, recovery/dashboard state presentation, and shared overlay/toast chrome. Current dashboard sections are registered there and render feature-owned React components from `src/ui/features/`. Feature-only models, forms, presentation helpers, and styles stay beside the feature. Shared components belong in `src/ui/components/` only after real reuse exists.

Unsaved form/input state should remain local to the owning React feature when it is not server state. Canonical project/task/process/connection data stays in the dashboard store. Electron-only authority remains behind the constrained `window.relaiDesktop` API exposed by `electron/preload.cjs`; React must not bypass IPC or move privileged desktop behavior into the renderer.

The first-run/recovery renderer is intentionally independent of the dashboard React tree. `electron/renderer/wizard.*`, `electron/renderer/status.*`, and `electron/recovery-window.js` must remain able to recover or configure the application when the dashboard is unavailable.

Dashboard JavaScript and CSS have source/generated boundaries:

- Vite bundles the production `public/dashboard.js` entry and its `src/ui/` dependency graph to `public/dashboard-app.js`, retains `src/ui/react/main.js` as `public/dashboard-react.js` for focused runtime probes, and preserves lazy route code splitting under `public/dashboard-chunks/`;
- Tailwind runs through the Vite integration from the shared `src/ui/styles/app.css` entry to `public/dashboard.css`; clearly route-owned feature styles are imported by their lazy React routes and emitted as hashed CSS under `public/dashboard-chunks/`;
- `public/dashboard-app.js`, `public/dashboard-react.js`, `public/dashboard.css`, and dashboard chunks (including route CSS) are generated artifacts and are not hand-edited; and
- `npm run verify:generated` rebuilds the Vite output into a temporary directory and fails when tracked generated bytes are stale.

Accessibility is part of the frontend contract: current-route semantics, route-heading focus, live-region announcements, focus trapping/restoration, keyboard navigation, reduced motion, forced colors, responsive navigation, and usable touch targets must survive feature changes.

Frontend behavior is protected at several levels: focused model/store/router/SSE unit tests, dashboard integration/smoke tests, representative browser acceptance, custom Electron chrome tests, Monaco/Changes browser coverage, and recovery-window tests. Add the narrowest regression at the ownership boundary that failed instead of copying the same assertion across unrelated suites.

## Secure tunnel ownership

`electron/secure-tunnel-runtime.js` is the sole owner of the bundled OpenAI tunnel-client child process. It:

- resolves the reviewed platform binary from packaged resources;
- passes the configured tunnel ID and control-plane key;
- maps the tunnel's `main` channel to the private local `/mcp` service;
- injects the Rel.AI bearer token only on the local forwarding hop;
- binds tunnel-client health to a local ephemeral health address;
- treats `/healthz` as the local child-liveness boundary, consumes v0.0.15 structured control-plane and response-delivery health, and keeps a live child in place while remote readiness/routing recovers;
- uses `/readyz` for the ready/running decision without turning prolonged OpenAI-side backoff into an outer process restart; and
- terminates the child only for explicit restart/shutdown, child exit, fatal tunnel errors, or sustained local-liveness failure.

`electron/tunnel-credentials.js` owns tunnel runtime API-key persistence through Electron `safeStorage`. The renderer sees only whether a key exists.

The canonical request path is:

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> bundled tunnel-client
  -> Authorization: Bearer <local Rel.AI token>
  -> private local POST /mcp
  -> normal MCP authorization and execution boundary
  -> configured workspace
```

The transport cannot select a repository by absolute path, bypass tool authorization, infer a `work_id`, or mark work complete.

## Canonical tool and action catalog

`src/tools/actionDefinitions.js` owns immutable tool definitions. `src/tools/actionCatalog.js` is the single owner of action mapping, authorization capability, approval policy, catalog construction, operation resolution, schemas, annotations, task scope, concurrency scope, execution class, dashboard metadata, and tool-surface version.

The public tool count is derived from the canonical runtime manifest (`release-manifest.json` records 14 for the current release). `src/tools/runtimeRegistry.js` contains executable function references only and deliberately does not become a second schema or policy source.

Connector result serialization remains operation-aware. It compacts safe fields, attaches `work_id` where required, and validates the selected action output schema before returning a result.

## MCP transports and compatibility

Modern MCP behavior targets protocol `2026-07-28`.

- `src/server.js` serves modern stdio and rejects initialize-based legacy lifecycle requests.
- `src/http/mcpTransport.ts` serves stateless HTTP MCP with strict protocol, method, name, capability, Host/Origin, and `_meta` validation.
- `src/http/mcpAuth.ts` accepts the private Rel.AI bearer token used by tunnel-client and explicit local clients.
- HTTP retains only the SDK-supported stateless `2025-11-25` startup lifecycle (`initialize` and `notifications/initialized`) required by supported ChatGPT clients; all ordinary MCP operations are modern-only.
- Native Task interception is owned by `src/mcp/transportTasks.js` before ordinary modern SDK dispatch.

The HTTP service does not expose the removed OAuth authorization server. `/register`, `/authorize`, `/token`, legacy `/sse`, and legacy `/messages` are absent.

## Task-state authorities

The task systems answer different lifecycle questions and remain separate:

| Concern | Authority |
| --- | --- |
| Live logical-task activity | `src/toolActivity.js` |
| Repository mutation generations, ownership/conflicts, and validation-evidence freshness | `src/taskIntegrity.ts` |
| Durable logical-task history | `src/taskHistoryStore.ts` and `src/taskHistoryStorage.ts` |
| Native MCP Task lifecycle | `src/mcp/nativeTaskService.js` |
| Canonical status mappings | `src/taskState.js` |
| Safe progress/event normalization | `src/taskObservability.js` and `src/taskEvents.js` |
| Dashboard read model | `src/http/dashboardData.js` |

Display state and 100% progress are never completion authority. For an explicit durable work session, completion is an explicit lifecycle record; Rel.AI records whether validation is passed, failed, stale, not run, or not required without using that evidence as a universal permission gate.

### Repository facts do not form a second planner

`src/workflow/` contains reusable factual helpers for task intent, repository topology, validation checks, risk classification, and evidence freshness. These helpers support hard runtime contracts and repository inspection; they do not generate model-facing stages or next-action recommendations. ChatGPT chooses the next repository action and appropriate validation from current evidence while authorization, path safety, Git containment, resource ownership, stale-write protection, workspace mutation/conflict facts, and defined destructive approvals remain authoritative.

### Restriction and recovery policy

Rel.AI restrictions must protect a concrete resource or failure mode. A `work_id`, validation gate, or approval prompt is not a general-purpose proof of safety.

- Treat `work_id` as optional durable attribution, not a permission token. Repository edits, one-shot commands, validation, process creation/input, local UI interaction, and computer control can use their authorized workspace/resource boundary without a synthetic task. If a caller explicitly supplies `work_id`, it must identify a valid compatible durable task; Rel.AI never silently drops or guesses it.
- Require `work_id` only when the requested semantics actually refer to a logical task: finish/cancel, `scope:"task"` review/checkpoints, session-owned tidy, task-owned default commit scope, and other explicitly task-relative operations.
- Resource operations use the narrowest real identity: managed processes use authenticated principal + workspace + `processId`; local UI uses principal + workspace + `sessionId`; taskless large command output uses principal + workspace + `outputRef`; taskless fallback continuation uses `operationId`.
- Native MCP Tasks and fallback operation IDs are transport/execution mechanisms. They must never be converted into fake logical `work_id` requirements.
- Approval is reserved for the destructive/high-risk operation itself. Workspace reset and real Git push remain approval-gated. Do not add model-supplied magic confirmation strings as a second pseudo-consent layer when native approval already binds the exact request.
- Validation is factual, risk-proportional evidence. A passed check becomes stale after relevant mutation, but stale/failed/not-run evidence is reported rather than converted into a generic prohibition on agent completion.
- Recovery should use the narrowest real identity. Observation, interaction, output recovery, and cleanup should not force users to resurrect an unrelated or completed logical task when principal, workspace, and resource/session identity are sufficient.
- Cross-workspace continuity is supplemental context, not authority. Require strong task-signature evidence before injecting portable task history: exact safe identifiers/paths or multiple meaningful intent signals may qualify, while one generic lexical overlap is insufficient. Same-workspace completed-task retrieval ranks compact summaries across the full retained history rather than truncating candidates by recency; exact path/error/test identifiers selectively promote matching full records so recall does not require loading every historical event timeline.

Any new restriction must document the concrete attack/failure mode it prevents and add a regression at the public action boundary. Tests must include the least-privileged successful path, not only refusal cases. If the same policy decision appears in workflow guidance and authoritative execution, share one predicate instead of maintaining stricter duplicate logic.

## Electron ownership and IPC

Factories remain only where a module owns mutable state, a framework object, an operating-system resource, events, timers, or lifecycle. Examples include window managers, tray, updater, lifecycle manager, task activity runtime, shutdown coordinator, runtime log buffer, tunnel runtime, tunnel credential store, and diagnostic path owner.

`electron/ipc-handlers.js` owns sender-constrained setup, recovery, service lifecycle, dashboard-window management, notifications, and shared utilities. `electron/ipc-handlers-dashboard.js` owns the dashboard-only analytics, desktop-settings, updater, and diagnostics capabilities. There are no provider-switch, device-pairing, hosted-usage, or approval-token IPC channels.

Connection status is projected through the existing server-status path and updates only the relevant dashboard regions. A tunnel reconnect does not remount the application or restart unrelated managed developer processes.

## Durable persistence

`src/durableState.ts` owns atomic local text/JSON promotion, restrictive file modes, optional backups, backup restoration, validation, and typed failures.

Local durable stores include configuration, connection profile, connection generations, task history/integrity, managed-process metadata, lifecycle state, and other repository-work state. The tunnel runtime API key is deliberately outside ordinary JSON configuration and is stored through Electron `safeStorage`.

## Compatibility exceptions

Retained compatibility is intentionally narrow:

- HTTP `2025-11-25` stateless startup lifecycle (`initialize` and `notifications/initialized`) for supported ChatGPT clients;
- historical task-status aliases normalized on read; and
- stable internal operation names retained in audit/history/authorization evidence where they are data contracts rather than transport modes.

Compatibility code must remain isolated and tested. The `2025-11-25` shim is startup-lifecycle-only and must not dispatch ordinary MCP operations. It must not create a second active source of schemas, policy, lifecycle, persistence, or connection transport.

## Current architecture metrics

| Metric | Current contract |
| --- | ---: |
| Public tools | Derived from canonical manifest (14 in current release) |
| Public actions | Derived from the canonical action catalog |
| Active public tool-schema source | 1 canonical catalog |
| MCP protocol | `2026-07-28` |
| Release schema version | 7 |
| Supported ChatGPT transport | OpenAI Secure MCP Tunnel only |
| Local MCP auth | Private bearer token |
| Public Rel.AI OAuth routes | 0 |
| Active transport provider modes | 1 |

## Validation and release boundaries

Architecture changes must preserve the public tool contract, local bearer authentication, tunnel-client provenance, optional durable work-session attribution, native Task parity, HTTP/stdio behavior, Electron sender isolation, managed-process cleanup, durable recovery, Git safeguards, and package integrity.

CI verifies source tests, generated assets, transport-removal contracts, tunnel-client provenance, Electron packaging, packaged bearer-authenticated MCP behavior, fuse policy, and release metadata. A real external Secure MCP Tunnel and logged-in ChatGPT integration require credentials and account state that are intentionally not embedded in CI; those remain explicit release acceptance evidence rather than something automated tests pretend to prove.
