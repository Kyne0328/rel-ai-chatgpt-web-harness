# Rel.AI MCP Desktop UX Architecture

## Purpose

This document defines the current production desktop experience after the Secure MCP Tunnel and React dashboard hard cutovers: navigation, setup behavior, Connection ownership, shared filters, responsive rules, and renderer boundaries.

Source development and packaging instructions live in [DEVELOPMENT.md](DEVELOPMENT.md).

## Product entry path

Rel.AI is an installed desktop application. The normal path is:

1. Open Rel.AI MCP.
2. Enter the OpenAI Secure MCP Tunnel ID and runtime API key when setup is required.
3. Start the secure connection.
4. Add a repository under **Projects**.
5. Create or reconnect the Rel.AI MCP integration in ChatGPT through the Tunnel connection option.
6. Work through Overview, Tasks, Changes, Projects, Activity, System, and Settings.

The dashboard is the routine application surface. The separate status window is recovery-only.

## First-run wizard

The wizard is intentionally small. It owns only the connection values required to start Rel.AI:

- Tunnel ID;
- write-only runtime API key;
- advanced local port when the default conflicts; and
- the action that saves configuration and starts the connection.

It does not expose source-development files, shell commands, diagnostic URLs, internal bearer tokens, or provider selection. Existing valid configuration may bypass the wizard and open the dashboard directly.

## Overview setup checklist

Overview shows only unfinished product work:

- choose a project;
- configure the secure tunnel;
- connect ChatGPT; and
- send a safe first Rel.AI request.

The checklist has one current action, supports dismissal, persists completion state, and disappears when setup is complete. It must not duplicate warnings already owned by Connection.

## Navigation ownership

`src/ui/navigation-catalog.js` is the source of route labels, descriptions, groups, icons, and command-palette destinations.

### Desktop navigation

Work contains Overview (`#home`), Tasks (`#tasks`), Browser (`#browser`), and Projects (`#workspaces`). System contains global Running commands (`#processes`), Activity (`#activity`), Troubleshooting (`#diagnostics`), and Analytics (`#usage`).

Settings remains at the bottom. Its Connection page is also reachable from the live topbar status. More contains the ChatGPT tools catalogue and, only when enabled, Extensions. Opening a secondary destination expands More and marks the destination current. The footer identifies the application surface without implying connection health.

Changes is part of each task's inspector, not a separate desktop or mobile destination. Legacy `#code` links normalize to the selected task's Changes tab while preserving its file and filter context. Connection remains canonical at `#settings/connection`, with Settings highlighted for all its subpages.

### Mobile navigation

The compact navigation retains Overview, Tasks, Projects, and Activity. More offers Browser, System destinations, Settings pages, and optional Extensions. Full-screen Changes is reached through the selected task; all existing deep links and quick-navigation destinations remain valid.

## Route policy

`src/ui/route-policy.js` owns canonical route normalization and allowed route parameters. `src/ui/router.js` owns hash navigation state, route parameter helpers, unsaved-change navigation protection, and route-change dispatch. `src/ui/react/main.js` owns route presentation, route-body selection/rendering, route-heading focus, and route-mounted announcements. Compatibility redirects may remain for removed dashboard hashes, but deleted connection modes must not return as visible destinations.

## Renderer ownership

The HTTP server emits a minimal dashboard shell and initial JSON. React owns the persistent dashboard shell and the current dashboard route bodies.

- `public/dashboard.js` coordinates startup, authoritative refresh/recovery, Electron status, hash-router initialization, and SSE-to-store delivery. It is not a feature renderer.
- `src/ui/react/main.js` owns navigation, page identity, route-body selection/rendering, route focus/announcements, the command palette, shared overlay/toast chrome, recovery/dashboard state presentation, and registration of React dashboard routes.
- `src/ui/store.js` owns canonical revision-aware dashboard client state.
- `src/ui/events.js` owns the single dashboard SSE connection. Features consume store updates instead of opening independent event streams.
- `src/ui/features/` owns feature-local React components, presentation models, forms, and styles.
- `src/ui/components/` is for genuinely shared UI behavior and primitives, not speculative abstractions.

Backend read models and lifecycle decisions remain backend-owned. React must not infer task completion, connection authority, process ownership, or project authorization from presentation state.

Feature forms keep unsaved values in local React state where appropriate. Server/project/task/process state stays in the canonical dashboard store. Desktop-only operations use the approved `window.relaiDesktop` preload bridge; renderer code must not recreate privileged Electron authority.

The first-run wizard and startup splash stay independent of the dashboard React tree. The splash shows automatic local startup retries, and the wizard handles configuration that requires user input. There is no separate recovery page.

## Settings ownership

Settings owns application configuration without duplicating feature controls:

- **Connection** — Secure MCP Tunnel configuration, status, and recovery guidance.
- **Preferences** — theme, density, and desktop notification preferences.
- **App** — launch-at-sign-in, lifecycle behavior, local data, updates, and other application-level controls exposed by the current implementation.
- **About** — version, project, repository, and license information.

Connection remains a dedicated settings route rather than being mixed into general Preferences.

## Shared ChatGPT guidance

`src/ui/features/settings/connection-guidance.js` owns the canonical create/reconnect guidance. It must describe only OpenAI Secure MCP Tunnel:

- create a tunnel and runtime API key;
- save the Tunnel ID and key in Rel.AI;
- wait for Connected;
- associate ChatGPT's Rel.AI MCP integration with that tunnel; and
- send the safe first read-only request.

Transport recovery, application updates, tool-schema refresh, and repository work completion are separate concepts and must not be presented as interchangeable actions.

## Connection page

Connection is status-first. It renders:

1. local connection health;
2. Secure MCP Tunnel health;
3. the configured Tunnel ID where useful;
4. one primary recovery/setup action;
5. quiet refresh and Diagnostics actions;
6. expandable connection layers; and
7. the tunnel settings form with a write-only replacement runtime key.

The advanced port control stays collapsed because most users never need it.

### Connection layers

The shared disclosure separates:

1. Connection service
2. Secure tunnel
3. Authentication
4. Client and tools
5. Dashboard updates

The disclosure may open automatically when an unhealthy layer needs attention.

## Shared filter system

Search remains visible. Simple choices such as tool capability and Activity time range use anchored menus with immediate selection; below 640px they use the shared filter drawer. Complex Activity and Diagnostics filters retain the drawer and narrow-screen sheet. Active filters render as removable chips, Clear all resets the current view, and result summaries use live status semantics.

Feature-specific filters remain owned by their feature rather than duplicated in global state.

## Task evidence and operations

Tasks retains the master-detail inspector with Overview, Details, Changes, Activity, and Processes tabs. Details shows the durable Work ID, available verified conversation ID, recorded execution status, timestamps, outcome, call counts, and validation status without exposing raw technical traces. Legacy `tab=technical` links canonicalize to `tab=details`; the retired Technical panel and its raw trace export remain absent. The header prioritizes the task title, status, and project. Tool-call counts come from task call accounting and remain the single user-facing work count in Tasks; Activity keeps its event timeline without a competing numeric count. Processes counts only task-owned entries. The Tasks route accepts validated `tab` and `file` parameters; Changes are presented only in the task's Changes tab; obsolete `#code` links are redirected to that tab without losing task or file context. Embedded diffs respond to their container width, validate task and file identity, and retain file/layout/scroll state while inactive editors are disposed.

Process attribution uses durable `workSessionId` and lifecycle fields. Task-bound and persistent processes started by the task are separate from other managed workspace processes, which remain collapsed until requested. Older task-owned records without lifecycle metadata remain visible in their own group. The inspector reuses Running commands status, recovery, Stop controls, and identity-verified memory readings; optional sampling stops on hidden documents and inactive tabs.

The retired runtime dock is no longer an alternate activity or command surface. Activity and Running commands own their respective data; Troubleshooting holds diagnostics and support exports. Missing evidence is never promoted to success.

## Resource diagnostics

System resources uses physical-memory and file-cache gauges, a bounded service-memory chart plotted against recorded sample timestamps, and active/capacity work bars. Missing or stale measurements remain unknown; charts add no polling or inferred process-family totals. Sample data, attribution limits, and detailed metrics remain under Technical resource details. Health check badges stay within their cards, with long tunnel identifiers wrapping on a separate line.

## Overview hierarchy

Overview prioritizes:

1. active work-session information;
2. unfinished setup;
3. compact connection readiness;
4. attention items not already represented by setup; and
5. supporting workspace/activity information.

## Styling ownership

`src/ui/styles/app.css` is the shared style entry. Feature styles live with their owning feature under `src/ui/features/`; genuinely shared component styles live under `src/ui/components/`. Styles needed across the shell or multiple routes remain in the shared entry, while clearly route-owned feature styles are imported by their lazy React route and use `@reference "tailwindcss"` for Tailwind utilities. `public/dashboard.css` is the generated shared stylesheet and must be rebuilt after source style changes.

Vite bundles the production `public/dashboard.js` entry and its `src/ui/` dependency graph to generated `public/dashboard-app.js`, retains `src/ui/react/main.js` as generated `public/dashboard-react.js` for focused runtime probes, emits the shared Tailwind CSS as `public/dashboard.css`, and emits lazy route CSS under `public/dashboard-chunks/`. These generated dashboard assets are not hand-edit surfaces.

## Responsive and accessibility behavior

- Controls wrap without horizontal overflow.
- Drawers become bottom sheets on narrow screens where defined.
- Cards and tables retain meaningful labels and touch targets.
- Fixed elements account for safe-area insets.
- Current navigation uses `aria-current`.
- Dialog/drawer focus is contained and restored.
- Route changes and live summaries are announced.
- Color is never the only status signal.

## Test ownership

Tests protect behavior rather than historical implementation details. Required contracts include navigation, React/store/SSE live behavior, stable route identity, tunnel-only setup, Electron-first public product copy, Connection create/reconnect guidance, sender-constrained IPC, shared filters, generated JS/CSS, accessibility behavior, recovery renderer independence, and representative browser acceptance. Obsolete imperative-renderer or transport-specific tests should be removed or rewritten when their production path no longer exists.
