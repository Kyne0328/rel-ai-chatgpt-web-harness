# Rel.AI Workflows

## Context economy

For each meaningful project goal handled through Rel.AI, begin or reuse one durable work session before the first project operation and carry its work_id through that goal, including read-only investigation. New durable work supplies a non-empty ordered steps plan on begin. Update individual steps through compact taskProgress patches and replace the full plan only when its structure changes. Projectless one-shot utility/control work is taskless; do not create an empty durable task or invent a workspace for it. If a mutation reports TASK_ATTRIBUTION_REQUIRED, retry with the matching work_id; use independent:true only for intentionally separate workspace/resource work. Escalate context only when the current decision requires it: search or inspect before broad reads, batch related reads, and reuse evidence that is still current. A handoff should carry conclusions and evidence locations so the next specialist does not restart the same investigation.

## Read -> edit -> validate

Read the current source and applicable repository instructions. Inspect impact when changing shared APIs, registrations, dependencies, or cross-cutting behavior. Use exact replacements for localized changes, patches for coherent multi-file changes, and full-file content only when the whole file genuinely changes. Validate the risk created by the mutation, then broaden validation only when the changed boundary requires it.

## Plan execution

For an approved durable plan, keep its checkboxes current. A task is complete only when its stated completion condition is satisfied. After Task N, review Tasks 1..N together and consolidate duplicated helpers, redundant layers, repeated tests, or temporary structures before moving on. Replan only when new evidence invalidates architecture, sequencing, dependencies, or completion conditions.

Do not stop after ordinary task boundaries merely to ask whether to continue. Stop only when blocked, when a material decision belongs to the user, when an external/manual step cannot be performed, or when final verification is complete.

## Fallback completion and validation lifecycle

When a bounded operation continues after a response, keep doing independent work and consume its later `completedOperations` notice instead of polling `relai_work status` unless the result blocks useful progress.

One durable work session can contain multiple background operations. Keep each returned `operationId`: task status lists retained operations, while operation status retrieves one exact result. Conflicting operations wait in the existing resource queue; an identical running request reuses its operation instead of starting another process. When a result blocks progress, stay in the active turn and retrieve that operation at the returned `pollAfterMs` interval. An accepted background command or a completion notification does not itself guarantee another assistant turn. After a host execution limit, recover the same work session, consume outstanding results, and continue its unfinished plan. Stop one command by its operation ID; task-wide stop/cancel covers all operations. Finish only after its queued and running operations have settled.

When the user asks to continue a specific `work_id`, retrieve its status before claiming that its execution session is unavailable. An inactive task is resumable. Reuse its plan, reconcile recorded operations and current files, and request deeper `context` only when necessary. If recovery fails, report the actual connection, ownership, or lifecycle error returned by the tools.

`relai_validate` records evidence and leaves durable work open by default. Use `complete:true` only for the final successful validation when closure should be atomic. Failed, cancelled, or stale validation never closes the goal; continue and revalidate, or explicitly finish with truthful residual risk when the objective is complete despite that evidence.

## Managed processes

Use `relai_process` action `start` only for a program that must persist or accept later input. Supply:

- `kind: "service"` for a development server or local service;
- `kind: "watcher"` for a file or build watcher;
- `kind: "interactive"` for a program that expects stdin;
- `purpose` describing why persistence is required.

Tests, builds, linters, source checks, package gates, and release validation are one-shot work and use `relai_exec` or `relai_validate`.

For a browser-rendered local app, retain the development-server `processId`, then create a workspace-scoped `relai_ui` session against its loopback port; `work_id` is optional attribution. Start with an accessibility snapshot when locating controls, prefer semantic targets for interaction, capture a screenshot when visual evidence matters, inspect console/network failures when relevant, and stop the UI session before the persistent service is no longer needed.

Retain `processId`. Read logs with byte offsets and reuse `metadataRevision` after the first read to avoid unchanged metadata. Stop the process when it is no longer required. A process handle is separate from both `work_id` and any fallback `operationId`.

## Change review and publishing

Use `relai_changes` action `diff` for focused status and patch review. Use `relai_publish` action `draft_pr` to prepare pull-request text. Commit or push only when the user requested it or the objective explicitly requires it. With a durable work_id, task-owned commit scope is a safe convenience; without one, select explicit paths or `addAll:true` intentionally.

## Error recovery

Use returned error codes, recovery data, and current status. Re-read after hash or stale-content conflicts. Stop or inspect managed processes before retrying lifecycle operations. Prefer focused restore over broad reset. Cancel the exact work session when abandoning partial progress; start a new work session for a different objective.

## Public tool surface

Rel.AI exposes its current public capability surface through the server. Exact action contracts and action-level execution metadata are available through `relai://server/tool-surface`; do not duplicate a numeric tool count here.
