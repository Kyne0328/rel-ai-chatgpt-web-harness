# Rel.AI Workflows

## Context economy

For substantial or multi-step repository work, begin a durable work session before the first project operation and carry its work_id on subsequent task operations, including when the first steps are read-only. Begin returns the durable identity before repository scanning; fetch bootstrap with relai_work action context using that ID when needed, and reuse that context. If a mutation reports TASK_ATTRIBUTION_REQUIRED, retry with the matching work_id; use independent:true only for intentionally separate workspace work. Isolated reads, inspections, and small one-shot operations can start directly with the smallest workspace-scoped evidence needed. Escalate context only when the current decision requires it: search or inspect before broad reads, batch related reads, and reuse evidence that is still current. A handoff should carry conclusions and evidence locations so the next specialist does not restart the same investigation.

## Read -> edit -> validate

Read the current source and applicable repository instructions. Inspect impact when changing shared APIs, registrations, dependencies, or cross-cutting behavior. Use exact replacements for localized changes, patches for coherent multi-file changes, and full-file content only when the whole file genuinely changes. Validate the risk created by the mutation, then broaden validation only when the changed boundary requires it.

## Plan execution

For an approved durable plan, keep its checkboxes current. A task is complete only when its stated completion condition is satisfied. After Task N, review Tasks 1..N together and consolidate duplicated helpers, redundant layers, repeated tests, or temporary structures before moving on. Replan only when new evidence invalidates architecture, sequencing, dependencies, or completion conditions.

Do not stop after ordinary task boundaries merely to ask whether to continue. Stop only when blocked, when a material decision belongs to the user, when an external/manual step cannot be performed, or when final verification is complete.

## Managed processes

Use `relai_process` action `start` only for a program that must persist or accept later input. Supply:

- `kind: "service"` for a development server or local service;
- `kind: "watcher"` for a file or build watcher;
- `kind: "interactive"` for a program that expects stdin;
- `purpose` describing why persistence is required.

Tests, builds, linters, source checks, package gates, and release validation are one-shot work and use `relai_exec` or `relai_validate`.

For a browser-rendered local app, retain the development-server `processId`, then create a workspace-scoped `relai_ui` session against its loopback port; `work_id` is optional attribution. Start with an accessibility snapshot when locating controls, prefer semantic targets for interaction, capture a screenshot when visual evidence matters, inspect console/network failures when relevant, and stop the UI session before the persistent service is no longer needed.

Retain `processId`. Read logs with byte offsets and reuse `metadataRevision` after the first read to avoid unchanged metadata. Stop the process when it is no longer required. A process handle is separate from `work_id` and native MCP Task IDs.

## Change review and publishing

Use `relai_changes` action `diff` for focused status and patch review. Use `relai_publish` action `draft_pr` to prepare pull-request text. Commit or push only when the user requested it or the objective explicitly requires it. With a durable work_id, task-owned commit scope is a safe convenience; without one, select explicit paths or `addAll:true` intentionally.

## Error recovery

Use returned error codes, recovery data, and current status. Re-read after hash or stale-content conflicts. Stop or inspect managed processes before retrying lifecycle operations. Prefer focused restore over broad reset. Cancel the exact work session when abandoning partial progress; start a new work session for a different objective.

## Public tool surface

Rel.AI exposes its current public capability surface through the server. Exact action contracts and action-level execution metadata are available through `relai://server/tool-surface`; do not duplicate a numeric tool count here.
