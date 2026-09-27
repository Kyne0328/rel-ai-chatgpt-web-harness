# Task observability architecture

## Scope

Rel.AI MCP uses one logical-task tracker, one canonical task-state vocabulary, one activity-event normalization path, one JSON session store, one snapshot-based Server-Sent Events transport, and one shared frontend clock. The observability implementation repairs those existing owners rather than introducing a second task model, event bus, persistence layer, polling loop, or realtime protocol.

The system reports what Rel.AI can observe: tool acquisition, queueing, approval waits, tool execution, validation work, progress, terminal outcomes, and persisted history. It does not infer ChatGPT's private reasoning or claim that an overall chat request is complete without an accepted completion call.

## End-to-end flow

```text
MCP tools/call
→ src/tools.js validates explicit work_id and runtime compatibility
→ src/toolActivity.js creates or acquires the logical task
→ src/tools/execution.js enters the workspace queue and tool handler
→ process, repository, validation, Git, or approval layer executes
→ src/taskObservability.js derives a sanitized structured outcome
→ the lifecycle event is updated by stable operation/event ID
→ src/taskHistoryStore.ts normalizes and upserts the canonical task snapshot
→ src/taskHistoryStorage.ts sanitizes before disk write and after disk read
→ src/http/dashboardData.js builds the canonical dashboard projection
→ src/http/dashboard.js publishes an ordered snapshot over the existing SSE stream
→ src/ui/snapshot-order.js rejects duplicate or stale snapshots
→ Sessions, Activity, progress, and elapsed-time views render canonical state
```

## Ownership

| Concern | Canonical owner |
| --- | --- |
| Task identity and active lifecycle | `src/toolActivity.js` |
| State vocabulary, terminal predicate, transitions, historical aliases | `src/taskState.js` |
| Safe titles, summaries, errors, metadata, progress, and copy projection | `src/taskObservability.js` |
| Explicit completion | `src/tools/completion.js` |
| Explicit cancellation | `src/tools/cancellation.js` and `src/toolActivity.js` |
| Validation and diagnostic work-unit progress | `src/bridge/validation.js` and `src/bridge/diagnosticsRunner.js` |
| Cooperative process cancellation | `src/abortSignals.js`, `src/process.js`, and process-backed bridges |
| Queue-wait activity | `src/tools/execution.js` through the current activity context |
| Persistence and historical read normalization | `src/taskHistoryStore.ts` and `src/taskHistoryStorage.ts` |
| Dashboard projection and copy-safe activity | `src/http/dashboardData.js` |
| Snapshot stream ID and sequence | `src/http/dashboard.js` |
| Duplicate/stale snapshot rejection | `src/ui/snapshot-order.js` |
| Presentation-only current time | `src/ui/clock.js` |
| Task progress rendering | `src/ui/components/task-progress.js` |
| Repository/runtime compatibility | `src/runtimeCompatibility.js` and `release-manifest.json` |

## Canonical task state machine

New writes use only these machine-readable states:

- `queued`
- `planning`
- `running`
- `waiting_for_approval`
- `blocked`
- `validating`
- `validation_failed`
- `inactive`
- `completed`
- `failed`
- `cancelled`

Terminal states are `completed`, `failed`, and `cancelled`. `inactive` is explicitly non-terminal and resumable. Warning counts are secondary execution metadata and do not replace an explicitly reported `completed` lifecycle state. The shared terminal predicate is used by the tracker and persistence layer so terminal timestamps and progress are not discarded by a different local status list.

### Allowed transitions

| From | Allowed next states |
| --- | --- |
| `queued` | `planning`, `running`, `inactive`, `cancelled` |
| `planning` | `running`, `waiting_for_approval`, `blocked`, `validating`, `validation_failed`, `inactive`, `completed`, `failed`, `cancelled` |
| `running` | `planning`, `waiting_for_approval`, `blocked`, `validating`, `validation_failed`, `inactive`, `completed`, `failed`, `cancelled` |
| `waiting_for_approval` | `running`, `blocked`, `inactive`, `failed`, `cancelled` |
| `blocked` | `running`, `waiting_for_approval`, `validating`, `validation_failed`, `inactive`, `failed`, `cancelled` |
| `validating` | `running`, `validation_failed`, `inactive`, `completed`, `failed`, `cancelled` |
| `validation_failed` | `planning`, `running`, `blocked`, `validating`, `inactive`, `completed`, `failed`, `cancelled` |
| `inactive` | `planning`, `running`, `blocked`, `validating` |
| Any terminal state | no nonterminal transition |

Repeating the same state is idempotent. A stale running or progress update cannot reopen or overwrite a terminal task.

### Terminal data

A terminal snapshot preserves, when available:

- `endedAt`;
- `completedAt` for successful completion states;
- `cancelledAt` for explicit cancellation;
- duration and last activity time;
- the final defensible progress snapshot;
- call, success, failure, and warning counters;
- sanitized error or result summary;
- `endReason` and `terminalReason`;
- a bounded cancellation initiator category.

## Inactivity and historical compatibility

Inactivity is a non-terminal, resumable lifecycle state. A work session that becomes quiescent transitions to `inactive` instead of being rewritten as cancelled or failed simply because no new tool call arrived.

An inactive snapshot preserves the logical task identity and evidence needed to continue safely:

- the same `work_id`, title, objective, workspace, and principal binding;
- task-owned changed files and task-integrity generations;
- current validation freshness and workspace-generation authority;
- durable safe workflow evidence receipts and the bounded workflow snapshot;
- call, success, failure, warning, and last-error counters;
- an `inactiveAt` timestamp.

It does not receive terminal `endedAt`, `completedAt`, or `cancelledAt` timestamps. A valid same `work_id` call from the authorized principal in the bound workspace implicitly resumes the work session into an active state. Resumption recreates live presentation state but does not create a second integrity model or reset authoritative mutation/validation history.

Explicit cancellation, explicit completion, and a true terminal failure remain distinct terminal outcomes and cannot be reopened through inactivity handling.

Historical records that used `inactive`, `expired`, or `endReason: inactivity_window` are normalized to canonical `inactive` when there is no explicit terminal action and completion is not known. Historical terminal records remain terminal. Unsafe historical strings are sanitized before entering the parsed-session cache, so they cannot persist in memory as an alternate raw representation that later leaks into another projection.

## Explicit cancellation

`relai_work` with action `cancel` targets the exact supplied `work_id`.

Cancellation:

- rejects an unrelated or unknown task;
- is idempotent for an already-cancelled task;
- refuses to overwrite another terminal outcome;
- bypasses the workspace operation lock so a control call can reach an active validation;
- records a bounded reason and initiator category;
- preserves partial progress and terminal timestamps;
- emits one terminal lifecycle transition;
- signals the task's shared `AbortSignal` to process-backed operations;
- prevents a late operation result from reopening or completing the cancelled task.

Cancellation is cooperative. Rel.AI terminates supported subprocess-backed operations through their existing process boundary. It does not claim that every external API, operating-system action, or third-party operation can be forcefully interrupted after the side effect has already occurred.

## Progress semantics

Progress is based on explicit work units. It is never inferred from elapsed time, log volume, or optimistic percentages.

### Determinate workflows

Validation and diagnostics resolve, normalize, and deduplicate their command list before execution when possible. A stable workload starts at `0/N`, advances after each completed check, and preserves the current check, index, result status, duration, warning/failure count, and skipped-check metadata.

For a two-check success path, observable progress is:

```text
0/2 → 1/2 → 2/2
```

A successful determinate task ends with completed units equal to total units and presents 100%.

### Failure and cancellation

- Stop-on-first-failure preserves the number of finished checks and the stable total.
- Continue-after-failure may finish all units, but a failed workflow is capped below a successful 100% presentation.
- A timed-out or launch-failed check is a failed unit.
- A cancelled in-flight check is not counted as completed.
- A failed or cancelled task retains its last defensible partial progress in history.
- The final event identifies the failing or cancelled check where known.

### Indeterminate workflows

Exploration, planning, approval waits, and operations without a stable denominator remain indeterminate. The UI does not fabricate `aria-valuenow`, a numeric percentage, or a synthetic total for those states.

## Activity lifecycle

Each tool invocation owns one stable `operationId`, which is also the activity `eventId` and invocation ID. The event is created in a running state and updated in place to `succeeded`, `failed`, `blocked`, or `cancelled`. Persistence upserts by event ID, so lifecycle updates do not create duplicate rows.

Audit events with the same operation ID enrich the canonical lifecycle record but do not increment task call counts a second time.

Permitted event data includes bounded category, action, state, title, summary, timing, tool name, workspace-relative target, sanitized resource URI, result status, affected-item count, warning count, normalized error, and allow-listed metadata. Raw arguments, unrestricted command output, file contents, environment values, and raw headers are not part of the dashboard activity projection.
Rel.AI observability follows the same projection rule. Explicit durable work sessions receive bounded task history and factual validation/ownership state; taskless workspace/resource operations still appear in Activity without manufacturing task rows. Raw evidence receipts, command output, unrestricted paths, environment values, headers, and secrets are not copied into the dashboard projection.

## Completion-summary privacy

Completion input accepts only a string. It normalizes whitespace, applies the canonical display-text sanitizer, enforces the final length limit after sanitization, and rejects an empty sanitized result.

The sanitizer covers bounded forms of:

- Authorization headers and bearer/basic credentials;
- API keys and generic/access/refresh/session/auth tokens;
- client secrets, passwords, cookies, and set-cookie values;
- common environment assignments containing secret-bearing key names;
- credential-bearing URLs and sensitive URL query or fragment values;
- private-key blocks;
- approval and authorization codes.

It deliberately preserves ordinary technical prose such as package names, safe normalized paths, HTTP status names, test names, tool names, version numbers, `tokenizer`, and `authorization flow`.

The same rules are reused defensively when completion-related strings enter:

- the task tracker;
- activity events;
- persisted history;
- historical record normalization;
- dashboard snapshots and SSE payloads;
- the Activity copy/export projection.

This is defense in depth, not a claim that arbitrary human text can be classified perfectly. Production-path tests use synthetic credential-like values and verify that the original values do not appear in the tracker, raw history JSON, dashboard payload, SSE-compatible snapshot, activity details, or copied safe JSON. Real credentials must never be used as test fixtures.

## Realtime and reconnect correctness

The existing canonical-snapshot SSE design remains authoritative.

Every snapshot includes a process-scoped stream ID, a strictly increasing sequence, a generation timestamp, and the task model version. A new connection receives the current canonical snapshot. The frontend rejects duplicate or lower sequences within the same stream, accepts a new ordering domain after restart, and restores persisted task state and progress after reconnect.

Stable event IDs make event upserts idempotent. Persisted terminal state rejects older nonterminal updates. No separate event-replay infrastructure is added because the canonical snapshot already supplies reconnect recovery.

## Runtime and repository compatibility

`release-manifest.json` records the authoritative application version, protocol version, tool-surface version, tool count, manifest hash, and schema version for a repository build. The running service exposes the same metadata from its actual package and tool registry.

When repository metadata is available, Rel.AI compares:

- application and package version;
- protocol version;
- tool-surface version;
- tool count;
- tool manifest hash;
- release-manifest schema version.

A repository-ahead mismatch reports `restart_required`. A runtime-ahead or other incompatible mismatch reports the precise direction and differences. The dashboard shows both versions and tool surfaces, preserves task history, and explains whether active tasks prevent a safe restart.

Known release-metadata skew is advisory and never blocks tool calls. `compatible` reports operational compatibility and therefore remains true while tools are available; `metadataMatches` separately reports whether the runtime and repository release metadata match exactly. This prevents connector clients from mistaking an advisory `restart_required` status for an editing boundary. This is essential when Rel.AI edits its own checkout: changing release or tool-surface metadata must not revoke the editing tools needed to finish or repair that work. The dashboard still reports the mismatch and offers restart/reconnect guidance, while active work can continue normally. Repository metadata being unavailable is reported explicitly with `metadataMatches: null` and does not fabricate a match.

## Frontend clock and accessibility

`src/ui/clock.js` owns one shared one-second timer for presentation-only time values. It updates opted-in clock nodes directly, does not trigger full-dashboard rerenders, pauses while the document is hidden, recomputes from source timestamps when visible, and anchors completed durations to terminal timestamps.

Determinate progress uses native `progress[value]` with a valid accessible label. Indeterminate progress exposes status text without a fabricated numeric value. State text accompanies color. Focus remains visible, timeline rows are keyboard operable, error text wraps, and indeterminate animation is disabled under reduced-motion preferences.

## Performance baseline and budgets

`npm run benchmark:observability` produces machine-readable JSON. The recorded Windows x64 / Node.js 24 release baseline has no preimplementation comparison and therefore establishes regression budgets rather than claiming an improvement. The benchmark launches an isolated Electron Chromium renderer for mandatory UI measurements; a launch failure, missing metric, nonnumeric result, or budget failure marks the report incomplete or failed and exits nonzero.

| Metric | Workload | Result | Budget |
| --- | --- | ---: | ---: |
| Activity events | 100 serial calls with one progress update | 300 | ≤305 |
| Atomic history writes | same workload | 0 | ≤305 |
| Coalesced snapshot publications | same burst | 1 | ≤5 |
| Queue-wait events | uncontended workload | 0 | 0 |
| History growth | 100 calls | 67,000 bytes | ≤2 MiB |
| Heap after 1,000 additional calls | bounded 200-event task timeline | 23,542,912 bytes | ≤256 MiB |
| Heap delta after GC | 1,000 additional calls | 550,336 bytes | ≤32 MiB |
| Snapshot size | canonical current task | 133,348 bytes | ≤512 KiB |
| Snapshot serialization | current task | 0.342 ms | ≤25 ms |
| Sanitization | 10,000 credential-like summaries | 43.588 ms | ≤250 ms |
| Logical task begin | fresh meaningful goal, median of five | 0.350 ms | ≤25 ms |
| Logical task progress | 200 retained task events, median of five | 0.520 ms | ≤25 ms |
| Logical task finish | 200 retained task events, median of five | 7.252 ms | ≤25 ms |
| Reconnect snapshot | warm median of five | 9.799 ms | ≤150 ms |
| Shared clock node updates | quiet 60 seconds | 60 | ≤60 |
| Quiet full dashboard renders | 60 direct clock updates | 0 | 0 |
| Full renders during progress | 100 progress updates | 0 | 0 |
| Timeline render | 200 events | 2.2 ms | ≤200 ms |
| Logical-task switch heap delta | 40 panel switches | 307,942 bytes | ≤16 MiB |
| Hidden-window timer | requested 100 ms | 104.1 ms | ≤1,500 ms |
| Renderer reconnect | 500-record current-state snapshot | 2.7 ms | ≤500 ms |

Latency and memory results vary by host; budgets are the release contract. Renderer metrics are never replaced with hardcoded or blocked placeholders.

## Known limitations

- Cancellation is cooperative and cannot reverse a side effect already committed outside a supported process boundary.
- Sanitization is bounded and pattern-based; callers must not intentionally place secrets in descriptive text.
- Runtime compatibility cannot be compared when repository release metadata is unavailable.
- Renderer acceptance and performance measurements require a Windows host on which Electron can start and execute JavaScript; inability to run them is a release failure, not a passing placeholder.
- Local development artifacts may be unsigned. Published artifacts require protected Authenticode signing and signature verification.

## Verification

Required coverage includes completion-summary sanitization, historical reads, canonical transitions, terminal timestamps, explicit cancellation, live validation and diagnostics progress, partial failure, reconnect restoration, runtime-version mismatch, snapshot ordering, shared-clock behavior, real Chromium dashboard interaction at 200% and 400% zoom, accessibility, executable performance budgets, packaged connector acceptance, and read-only release-artifact verification. Any failed or incomplete mandatory metric keeps the release decision at **Not ready**.
