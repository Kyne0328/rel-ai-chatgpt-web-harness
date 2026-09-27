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

### Work

1. Overview — `#home`
2. Tasks — `#tasks`
3. Changes — `#code`
4. Projects — `#workspaces`
5. Activity — `#activity`

### Application

1. System — opens at `#processes` and owns Running commands (`#processes`), Troubleshooting (`#diagnostics`), ChatGPT tools (`#tools`), and Analytics (`#usage`).
2. Settings — opens at `#settings` and owns Connection (`#settings/connection`), Preferences (`#settings`), App (`#settings/application`), and About (`#settings/about`).

System and Settings use the primary sidebar accordions rather than duplicating those destinations in an in-page settings rail. Direct hashes remain canonical for contextual navigation.

### Mobile navigation

The compact navigation keeps the top-level destinations available in the desktop navigation model; System subpages remain reachable through their owning surface and the command palette.

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

The first-run and recovery surfaces stay independent of the dashboard React tree. The wizard/status renderer and `electron/recovery-window.js` must still work when dashboard JavaScript, dashboard data, or the local service is unhealthy.

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

Activity, Tools, and Diagnostics use the shared filter bar/drawer components. Search remains visible, filters open in a drawer or narrow-screen sheet, active filters render as removable chips, Clear all resets the current view, and result summaries use live status semantics.

Feature-specific filters remain owned by their feature rather than duplicated in global state.

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
