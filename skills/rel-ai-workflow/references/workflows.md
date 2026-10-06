# Rel.AI Workflows

## Context economy

For each meaningful project goal handled through Rel.AI, begin or reuse one durable work session before the first project operation and carry its work_id through that goal, including read-only investigation. New durable work supplies a non-empty ordered steps plan on begin. Update individual steps through compact taskProgress patches and replace the full plan only when its structure changes. Projectless one-shot utility/control work is taskless; do not create an empty durable task or invent a workspace for it. If a mutation reports TASK_ATTRIBUTION_REQUIRED, retry with the matching work_id; use independent:true only for intentionally separate workspace/resource work. Escalate context only when the current decision requires it: search or inspect before broad reads, batch related reads, and reuse evidence that is still current. A handoff should carry conclusions and evidence locations so the next specialist does not restart the same investigation.

## Read -> edit -> validate

Read the current source and applicable repository instructions. Inspect impact when changing shared APIs, registrations, dependencies, or cross-cutting behavior. Use exact replacements for localized changes, patches for coherent multi-file changes, and full-file content only when the whole file genuinely changes. Validate the risk created by the mutation, then broaden validation only when the changed boundary requires it.

## Plan execution

For an approved durable plan, keep its checkboxes current. A task is complete only when its stated completion condition is satisfied. After Task N, review Tasks 1..N together and consolidate duplicated helpers, redundant layers, repeated tests, or temporary structures before moving on. Replan only when new evidence invalidates architecture, sequencing, dependencies, or completion conditions.

Do not stop after ordinary task boundaries merely to ask whether to continue. Stop only when blocked, when a material decision belongs to the user, when an external/manual step cannot be performed, or when final verification is complete.

## Fallback completion and validation lifecycle

When a bounded operation continues after a response, keep doing independent work and consume its later `completedOperations` notice. When the result blocks useful progress, retrieve the existing `operationId` with `relai_work` action `result`; connector retrieval waits up to five seconds for completion. Use `waitMs:0` or action `status` when an immediate receipt is needed.

One durable work session can contain multiple background operations. Keep each returned `operationId`: task status lists retained operations, while operation retrieval reads one exact result. Conflicting operations wait in the existing resource queue; an identical running request reuses its operation instead of starting another process. When a result blocks progress, stay in the active turn and retrieve that operation with action `result`. If it remains running after the bounded wait, follow the returned `pollAfterMs` before retrieving again. An accepted background command or a completion notification does not itself guarantee another assistant turn. After a host execution limit, recover the same work session, consume outstanding results, and continue its unfinished plan. Stop one command by its operation ID; task-wide stop/cancel covers all operations. Finish only after its queued and running operations have settled.

When the user asks to continue a specific `work_id`, retrieve its status before claiming that its execution session is unavailable. An inactive task is resumable. Reuse its plan, reconcile recorded operations and current files, and request deeper `context` only when necessary. If recovery fails, report the actual connection, ownership, or lifecycle error returned by the tools.

`relai_validate` records evidence and leaves durable work open by default. Use `complete:true` only for the final successful validation when closure should be atomic. Failed, cancelled, or stale validation never closes the goal; continue and revalidate, or explicitly finish with truthful residual risk when the objective is complete despite that evidence.

## Recover interrupted work without repeating side effects

Use this procedure after a lost response, interrupted assistant turn, expired result, or stale work identifier:

1. Retain the original workspace, `work_id`, `operationId`, and any `outputRef`. Read `relai_work` action `status` for that existing work. Use compact status first; page with the returned operation cursor instead of widening every poll.
2. Retrieve the existing operation with `relai_work` action `result` and its `operationId`, or use action `status` with that `operationId`. These are read-only retrievals. An accepted receipt is not completion, and a ready result is not proof that the caller acknowledged it.
3. Follow returned output references and byte offsets when output is truncated. Use the current tool-surface contract for stream retrieval. `maxResponseBytes` bounds the response envelope; it is separate from repository/log budgets. Never repeat an edit, command, publication, or other mutation just to obtain its old result.
4. Reconcile recorded completion against the actual artifacts and task-owned diff. Check only the affected files, hashes, output paths, or published revision needed to establish the next step. Mark each stage verified, incomplete, or uncertain; do not infer success from an inactive task or missing receipt.
5. Resume only the next verified unfinished stage on the same work session. A stale or missing work ID is a scope/recovery question, not permission to adopt a different task. If necessary, use read-only `relai_work` action `history` for the exact workspace and current principal, continuing its opaque cursor; match the requested goal before choosing a work ID.
6. If a result has expired or evidence conflicts, report exactly what is known and what remains uncertain. Do not resubmit an uncertain mutation. Obtain fresh authority for any materially changed action, and preserve ownership/quarantine while termination remains unconfirmed.

Keep a compact handoff: workspace/work ID, outstanding operation IDs, verified artifact/check receipts, next unfinished stage, and the specific uncertainty. Do not carry full historical result bodies into each status poll.

## Diagnose a waiting operation by its measured phase

Retrieve the existing operation first. Read its timeline, phase start, last-progress time, measured durations, deadline kind, blocking owner/operation/task, execution flag, and termination certainty. Missing fields mean unknown, including on older runtimes. Elapsed time alone does not establish a hang.

- `accepted`, `queued`, or `host-queued`: admission or host capacity may still be pending. Identify the recorded blocker. `executed:false`, `WORKSPACE_OPERATION_QUEUE_TIMEOUT`, and queue-admission `WORKSPACE_OPERATION_ABORTED` are not evidence that a child process spawned. An operation deadline may include queue time; an admission cap is a different budget.
- `admitted` or `preparing`: the resource was admitted, but process start may still be pending. Inspect the next recorded progress point; do not reset the queue to force execution.
- `running` or `spawned`: the handler or command has started. Use that operation's retained output and existing process evidence. A handler can execute without spawning a child.
- `exited`, `draining-output`, or `drained`: the root command has exited or output collection is underway. This is not the same as confirmed process-tree termination. Check output-finalization warnings and retained partial output.
- `reconciling` or `persisting`: changes or the result are being recorded. Inspect existing artifact evidence and last progress; do not run the original mutation as a diagnostic.
- `result-ready` or `delivered`: retrieve the existing result. Only an explicit receipt acknowledgement establishes delivery; a protocol completion/cancellation label does not establish process-tree termination.

If stopping is authorized, target the exact finite operation ID. A stop request is not a verified stop. Recheck termination certainty and preserve lane ownership or quarantine until the runtime confirms safety. Do not bypass mutation guards, cancel another task, restart an active service, or increase all timeouts merely to make a wait disappear.

## Verify the deployed build before claiming a fix is live

1. Record the expected build ID, source revision, dirty state, source fingerprint, schema digest, and the checks run against those bytes when producing the package.
2. Request current full runtime status once when needed. Compare its cached `runtime.buildIdentity` against the expected artifact. Release version, tool-surface/schema compatibility, and matching release metadata do not prove source/build parity.
3. Treat absent build provenance, an unknown parity result, or unmatched fingerprints as unverified deployment. Do not relabel protocol compatibility as deployed-code equality, and do not hash the whole repository on every status poll.
4. After an authorized install/restart, reconnect and read the new runtime identity and start time. An earlier task narrative or the package filename is not evidence of which runtime is now serving calls. Respect active work and shutdown protections; deployment authority does not imply permission to terminate unrelated work.
5. Exercise the changed tool route with a bounded safe acceptance check against the connected runtime. Record the actual runtime fingerprint with that result. Report implementation, source-test evidence, installed artifact identity, and live route verification as separate claims when only some are established.

## Resource pressure and repository cost

For heavy-work admission, explicit process lifetimes, honest mutation coverage, generated-output placement and opt-in Git tuning, follow [resource-aware execution](resources.md). Preserve stop/status access while work queues. Do not retry the physical command to retrieve a result or bypass a pressure queue.

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
