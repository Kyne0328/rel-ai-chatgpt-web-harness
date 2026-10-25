# Dashboard feature structure

The dashboard uses a feature-first React structure. Each user-facing capability owns its route component and feature-specific implementation details under this directory. Backend projections and the canonical dashboard store remain outside feature presentation code.

## Feature boundaries

- `home/` owns the Overview experience and its presentation model.
- `sessions/` owns Tasks/Sessions history, live task presentation, and inspector behavior.
- `workspaces/` owns Projects/Workspaces cards, forms, repair/delete flows, and project-specific navigation.
- `activity/` owns activity history, filters, stable event-row presentation, and its inspector.
- `code/` owns the read-only Changes/Monaco route.
- `processes/` owns managed-process presentation and controls.
- `tools/` owns the tool catalog/reference route.
- `usage/` owns local analytics/usage presentation and range models.
- `settings/` owns application preference/configuration panels and the current Troubleshooting/Diagnostics React implementation used by the System destination.
- `onboarding/` owns browser onboarding state and desktop handoff helpers used by Overview.
- `system/` currently owns shared styling for the System navigation surfaces; the concrete System destinations are the React-owned Processes, Diagnostics, Tools, and Usage routes.

Cross-feature infrastructure remains in `src/ui/`: routing, API access, canonical store state, SSE delivery, interaction safety, preferences, and connection state. The React shell and top-level route registry live in `src/ui/react/main.js`. Reusable visual/interaction primitives remain in `src/ui/components/`.

## State and live-update rules

- React renders dashboard routes; do not add a second imperative feature renderer beside a React route.
- Backend/API projection remains authoritative for backend state and lifecycle decisions.
- `src/ui/store.js` is canonical client state and is revision-aware. Features consume the store; they do not maintain competing copies of server state.
- `src/ui/events.js` owns the dashboard SSE connection. Do not create feature-specific `EventSource` instances.
- Keep unsaved form values, open/closed controls, selection, and similar UI-only state local to the owning feature when possible.
- Use stable domain identifiers for live lists. Do not use array indexes where inserts/updates would destroy unrelated rows.

## Rules for new UI code

1. Add user-facing behavior to the feature that owns it; do not create another generic `sections` or `pages` directory.
2. Keep imports between features explicit. Move logic to shared infrastructure only when at least two features require the same stable behavior.
3. Put feature-only CSS beside the feature and import it from `src/ui/styles/app.css`.
4. Use Tailwind utilities for layout, spacing, and responsive composition. Use named component classes for product-specific states and semantics.
5. Register a new top-level route in `src/ui/react/main.js` only when the product actually exposes that route.
6. Preserve accessibility contracts: semantic navigation/current state, keyboard operation, focus restoration/containment, live announcements, reduced motion, forced colors, and responsive reachability.
7. Desktop-only authority must use the approved preload bridge (`window.relaiDesktop`); feature code must not import Electron or expose new privileged renderer behavior without an IPC contract.
8. Add focused tests for the feature/model/store boundary that changed and browser/Electron acceptance only where the real interaction crosses those boundaries.
9. Keep `public/dashboard-app.js`, `public/dashboard-react.js`, `public/dashboard.css`, and `public/dashboard-chunks/` generated. Edit source under `src/ui/` or the production dashboard entry, then run `npm run build:frontend` and `npm run verify:generated`.

## Shared visual roles

The product identity is charcoal surfaces with lime primary actions (and semantic light-theme equivalents). Keep status information, success, warning and danger distinct from brand selection. Use the generated `--ui-*` palette; do not introduce feature palettes or decorative card elevation.

Geometry is role-based in `styles/app.css`:

| Role | Token / contract |
| --- | --- |
| Normal action and field | `--control-height` = 44px, `--control-radius` = 8px |
| Dense desktop action | `--control-height-dense` = 36px; explicit `.dense-button`, 44px for coarse pointers |
| Compact action copy | `.compact-button` reduces padding/type only; its target remains 44px |
| Card and composite container | `--card-radius` = 12px, `--card-inset` = 16px |
| Dialog or drawer | `--overlay-radius` = 16px, `--overlay-inset` = 20px |
| Search/filter container | `--filter-inset` = 12px, `--stack-gap` = 12px |
| Selection control | `--selection-radius` = 8px; use semantic selection/action colors |
| Technical output | `--technical-font-size` = 13px, `--technical-line-height` = 1.6, `--technical-radius` = 8px |
| Noninteractive status | `--status-height` = 36px; explicit `.status-pill-compact` = 24px |
| Text hierarchy | `--text-page-title`, `--text-section-title`, `--text-card-title`, `--text-metric`, `--text-metric-compact` |

Use the 4/8/12/16/24px spacing scale for equivalent roles. Specialized workbench/inspector layouts may retain meaningful density and hierarchy. Technical output must explicitly choose wrapped prose, unwrapped commands/logs, JSON, or diff whitespace; visual alignment must not truncate content or change that policy. Empty views must distinguish first use, no results, no selection, loading, unavailable data and recoverable error.

No user-facing density preference exists. The former dormant `data-density="compact"` overrides are removed; do not reintroduce a global setting to justify isolated compact controls. Native Browser chrome and Pulse retain their specialist geometry and need complete hit-area checks. Setup/Recovery use system theme; dashboard/Pulse follow the selected theme. Electron typography is intentionally separate until equivalent roles are verified on its native surfaces.

### Control and icon states

Use native buttons for actions, anchors for navigation, and native fields. Shared primary, secondary and danger classes provide rest/hover/active/focus/disabled states. Danger feedback retains its danger palette. Disabled rules must beat component variants. Busy actions need a visible progress label plus `aria-busy="true"`; the owning feature must also prevent repeat submissions and decide whether Cancel remains available. CSS alone does not disable an `aria-disabled` anchor or button: the owner must block activation. An async error should remain visible with a useful recovery action.

`Icon` is decorative by default. Its `size` (default 16) and `strokeWidth` props are authoritative, including inline dimensions, and must not be overridden by a feature glyph selector. Give an icon-only control its own accessible name and independently sized hit area. Use the central Lucide registry, including `puzzle` for extension skills; unknown names retain a safe help fallback. Do not add a second icon family.

### Overlay composition and workflow ownership

Use `components/overlay-frame.js` for the controlled Radix Root/Portal/Overlay/Content and panel geometry. `OverlayFrame` accepts `open`, `onOpenChange`, `kind` (modal/drawer), modal `size` (compact/standard/wide), `className`, `backdropProps`, `contentProps`, `panelProps` and children. Compose `Dialog.Title`, optional `Dialog.Description`, `.modal-head/.modal-body` or drawer equivalents inside it. When no description is appropriate, pass `'aria-describedby': undefined` through `contentProps`.

The frame does not own business policy. Keep dirty checks, busy dismissal locks, destructive Cancel-first focus, nested AlertDialog resolution, combobox keyboard behavior, and initial/return-focus callbacks with the feature. Forward these callbacks through `contentProps` without replacing them with a generic close handler. Initial focus and focus restoration must be tested when the original trigger is removed, a nested confirmation is cancelled, a save fails, or an async operation remains busy.

### Navigation and accessibility verification

Desktop navigation, narrow More groups and Quick navigation consume the canonical navigation catalog. All System and Settings child destinations must be reachable without search at narrow widths. Preserve route guards, developer gating, active-page indication, parameter-owned selection and project context. Quick navigation has a persistent accessible name independent of shortcut visibility.

Validate changes in both themes at 1180/1024/980/760/761/520/420/320 CSS px as relevant, with keyboard use, 200%/400% zoom, reduced motion, forced colors, long Unicode paths and interrupted/repeated actions. Focus must remain visible and controls must reflow; code and matrices may keep necessary local two-dimensional scrolling. WCAG 2.2 AA target-size requirements are not a blanket 44px rule, but 44px remains this product's normal control target. Source declarations and unit tests do not establish rendered or assistive-technology conformance.
