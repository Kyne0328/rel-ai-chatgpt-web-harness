# Repository performance audit

Date: 2026-09-17. Scope: current working tree, including uncommitted changes.

This is a subsystem-level performance review of backend/MCP and HTTP execution, repository indexing/search, persistence/analytics, process output, Electron lifecycle, React state/rendering, language servers, browser/computer resource limits, and benchmark coverage. It is not a claim that every line or workload was profiled. Application files were not edited by this audit.

The working tree changed during review. In particular, route/telemetry lazy loading, dashboard limits, task-history worker persistence, pruning, and benchmark instrumentation were being updated independently. Findings below were checked against the newer files; old claims from `startup-performance-audit.md` are not carried forward automatically. Measurements describe the code loaded when each process began, not an immutable release build.

## Measurements

Environment: Windows, shell Node v24.13.1. The repository requires Node >=26.8.2 <27. These are diagnostic observations, not supported-runtime release results. No hardware-normalized or OS-cache-cold claims are made. Benchmark workloads were launched sequentially; other activity on the shared machine was not controlled.

| Workload | Result |
| --- | --- |
| Index 1,000 tiny JS files, one changed file | Full build 4,273.47 ms; incremental refresh 59.49 ms |
| Index 10,000 tiny JS files, one changed file | Full build 24,861.32 ms; incremental refresh 663.89 ms |
| Index process RSS after full / incremental, 10,000 files | 173.75 / 208.22 MiB; process-wide, including workers, not module-exclusive allocation |
| Execution benchmark, 3 samples, median Git status | 113.84 ms |
| Same benchmark, no-op command / executor wall time | 806.42 / 1,016.95 ms |
| Same benchmark, executor overhead | 210.52 ms |
| Same benchmark, tool-dispatched execution / read / text search | 978.11 / 86.31 / 148.46 ms |
| Latest startup test, initialization / first tools list / warm list medians | 1,634.53 / 3.90 / 2.02 ms; all three budgets passed |
| Observability run | 24 advisory checks passed; storage/write/queue metrics used older instrumentation and are not reliable evidence |
| Canonical snapshot probe, 0 / 100 / 200 synthetic events | 0.026 / 2.918 / 4.071 ms per snapshot; median of 3 batches of 20 calls |

Commands:

```text
node scripts/repository-intelligence-benchmark.mjs --files 1000 --mutations 1 --json
node scripts/repository-intelligence-benchmark.mjs --files 10000 --mutations 1 --json
node scripts/benchmark-exec-phases.mjs --samples=3
node --expose-gc scripts/observability-benchmark.mjs --output=dist/performance-audit-observability.json
node test/mcp-startup-budget-unit.mjs
```

Both indexing runs verified file counts and incremental mode. Their `thresholdsPassed: true` fields do not establish a performance pass: no timing thresholds were supplied. The fixture has no realistic import graph and disables watchers. The execution benchmark's zero orchestration overhead is a clamped difference between separate samples; it does not mean orchestration is free.

The observability run's complete raw output is saved in `dist/performance-audit-observability.json`. Its one-task warm dashboard median was 74.557 ms, its tight loop of 1,000 analytics updates took 263.766 ms, and final snapshot serialization took 0.577 ms. These results do not establish mature-history performance. Its renderer measurements use a synthetic DOM fixture, not the production React routes (see verification gaps below).

The snapshot microprobe imported `canonicalTaskSnapshot` directly, warmed each fixture once, then timed three batches of twenty calls. Fixtures contained a running task and 0/100/200 simple successful read events with event IDs, sequence numbers, ISO timestamps, summaries, and a workspace name. These inexpensive synthetic events are not representative of all real event payloads; this is a relative cost probe, not an end-to-end tool benchmark.

## Findings

### 1. High: one-file index updates still perform global database work

Evidence: `src/repository/intelligence/indexBuild.js:114` runs `checkIndexIntegrity` on every refresh and line 121 loads the whole manifest. `src/repository/intelligence/database.js:585` uses full `PRAGMA integrity_check`. Even scoped relationship resolution reads every file at line 345, all symbols at lines 385 and 410, and all relation hints at line 415 before filtering their sources in JavaScript. Additions/deletions also disable the narrow relationship path under the conditions at `indexBuild.js:151`.

Impact: editing one file scales with total repository/index size. The same one-file mutation grew from 59.49 to 663.89 ms as the fixture grew 10x. This supports the scaling concern but does not isolate the time attributable to each query. Worker isolation protects the main event loop, but longer work consumes the shared heavy-work lane and delays fresh results.

Fix: use targeted manifest queries and indexed symbol/hint lookups for incremental changes. Maintain shared resolution metadata by generation rather than reconstructing it wholesale. Move full integrity validation to an explicit validated startup/recovery/maintenance policy, preserving corruption detection. Add separately timed integrity, manifest, parse, relationship, and commit phases. Gate one-file update latency at multiple repository sizes and include additions, deletions, common symbol names, and realistic imports.

### 2. High: managed-process log queues have no byte-level backpressure

Evidence: `src/processManager.ts:627` accepts every stdout/stderr chunk. At line 648 a 64 KiB batch is removed from the visible buffer and captured in another promise chained behind previous disk writes. Data listeners at lines 417 and 440 keep receiving output. There is no pending-write byte limit or pause/resume policy. `maxLogBytes` is applied to the on-disk file by `trimLog` at line 674, after writing.

Impact: a verbose build/dev server on slow storage can retain arbitrarily many queued buffers even though the disk log is capped. Once output stops, draining the queue also delays reads/termination paths that await persistence. This is a confirmed queue design issue; a production memory exhaustion was not induced.

Fix: account for all queued/in-flight bytes; pause pipe streams at a high-water mark and resume below a low-water mark. Define an explicit bounded spool or truncation policy for PTY output. Preserve output offsets and report any lost bytes. Validate sustained output against deliberately slower writes, checking RSS, outstanding bytes, cancellation, and shutdown time.

### 3. Medium: analytics rewrite the entire month's JSON synchronously on each outcome

Evidence: `src/tools/callTool.js:329` records the outcome in the tool path. `src/localAnalytics.ts:151` reads the month's payload, updates aggregate/hourly arrays, and serializes the entire document again through lines 386–399. Transport events repeat this at line 223. Transactions are synchronous at line 455. Connection reuse ends in a microtask at line 481, so a tight synchronous benchmark benefits from reuse that separate requests generally cannot share.

Impact: per-call CPU, allocation, and write volume grow with retained hourly/workspace/tool dimensions. Synchronous work delays other requests; SQLite lock waits can compound this. A one-hour, one-workspace loop is not representative of a mature monthly document. Deferred task-history writes now use a worker, but that change does not remove analytics work from the service thread.

Fix: store aggregate counters by indexed dimension and hour, update only affected rows, and own writes in a persistent database worker. Keep the existing durable-before-acknowledgement contract where required. Benchmark mature monthly fixtures and interleave calls across event-loop turns; measure p95/p99 and event-loop delay.

### 4. Medium: dashboard recent-event lookup scans retained event arrays before limiting results

Evidence: `src/core/dashboard-data.ts:66` calls `readRecentTaskHistoryEvents` during snapshot construction. `src/taskHistoryStorage.ts:126` expands every task payload with `json_each`, extracts timestamps, sorts the events, and only then applies `LIMIT`. The query has no indexed event timestamp or task prefilter.

Impact: a dashboard requesting 100 rows can process roughly 100,000 events with 500 retained tasks at the normal 200-event cap. The newer task-summary limit improves summary reads but does not bound this event query's input. This SQL remains synchronous on the service thread. The scaling mechanism is confirmed statically; loaded-history latency has not been measured here.

Fix: maintain a normalized, indexed event projection with stable event identity and timestamp ordering; retrieve recent events directly with pagination. Preserve cross-task recency semantics. Test 500 full histories, rather than only one task, and measure snapshot latency alongside a concurrent health request.

### 5. Medium: active language-server sessions retain all opened documents and reread cache hits

Evidence: `src/codeIntelligence/lspManager.js:179` reads the full file before checking cached size/mtime. Every new document, including its full text, is retained in `openDocuments` at line 202. `touch` at line 284 resets the whole session's two-minute idle timeout on each use; maps are cleared when the session stops. There is no per-document count/byte eviction.

Impact: a continuously active task visiting many files retains their text in the service and keeps the documents open in the language server. Repeated queries on unchanged files still pay synchronous file-read/allocation cost. Idle eviction bounds inactive sessions but does not bound a busy one.

Fix: check metadata before reading unchanged content, with the project's required invalidation guarantees. Add byte/count-limited document LRU eviction and `didClose` notifications, pinning documents involved in pending requests. Test sustained navigation without a two-minute idle gap.

### 6. Medium: command output spilling writes synchronously in stdout callbacks

Evidence: `src/process.ts:397` appends output directly from child stream handlers. `BoundedOutputBuffer` forwards spilled output to `src/outputSpill.js:63`, whose append path calls `fs.writeSync` at line 77. Per-file/global caps are 32/256 MiB, so retention is bounded, but the writes block.

Impact: large command output trades bounded heap for synchronous disk work on the shared service event loop. Disk latency directly delays MCP/dashboard handling and cancellation callbacks. This is distinct from the unbounded async managed-process queue above.

Fix: use an asynchronous spill writer with bounded queued bytes and upstream backpressure, maintaining caps, ordered content, offsets, and completion acknowledgements. Measure concurrent request latency while spilling representative build output.

### 7. Medium: SSE delivery ignores socket backpressure

Evidence: `src/http/io.ts:190` ignores every `res.write` return value. `src/http/dashboard.ts:80` connects event subscriptions directly to this writer and only removes them when the request closes. There is no bounded outbound byte queue, `drain` handling, or slow-client cutoff.

Impact: a connected dashboard that reads slowly can accumulate serialized events in the response buffer. Event coalescing limits production frequency, but it does not bound a socket's backlog. This was identified by source inspection; no network stress test was performed.

Fix: bound bytes per connection, honor `drain`, and disconnect/resnapshot when the bound is exceeded. Coalesce only events whose revision/state semantics permit it. Validate with a deliberately slow local reader and assert a stable memory bound and correct reconnection state.

### 8. Medium: non-Git execution performs two synchronous workspace scans

Evidence: `src/bridge/exec.js:140` takes the before snapshot, falling back to `readFilesystemStatusMap` at line 64 when Git status is unavailable. That function synchronously traverses directories and stats up to 50,000 files. Line 189 repeats the scan after execution. The fallback text-search collector also enumerates the workspace synchronously in `src/bridge/search.js` before its per-file loop.

Impact: a trivial command in a large non-Git folder can spend far more time accounting for changes than executing, blocking unrelated service requests during traversal. In Git workspaces, the measured roughly 211 ms executor overhead is consistent with the two status calls, but it is not a measurement of the non-Git fallback.

Fix: perform mutation-accounting scans in a worker or a yielding bounded-I/O scanner; reuse trustworthy watcher state with reconciliation. Preserve completeness and fail-closed mutation accounting. Do not disable tracking merely to improve timings. Add large non-Git fixtures to execution benchmarks.

### 9. Medium: task snapshots repeatedly sanitize the complete retained timeline

Evidence: `src/taskLifecycle.js:18` calls `sanitizeTaskRecord`, separately maps `sanitizeActivityEventRecord`, then calls `sanitizeTaskRecord` again when returning. `src/taskObservability.js:513` itself maps the entire event array. `src/taskHistoryStore.ts:142` invokes canonicalization and lifecycle merging for activity updates; `src/toolActivity.js:745` also canonicalizes live snapshots.

Impact: one canonicalization performs at least three sanitization passes over up to 200 events. Repeating it through update, merge, and public projection multiplies CPU/allocation per event. The cap prevents unbounded timeline growth, but full timelines are substantially more expensive than empty ones: the isolated probe measured 4.071 ms for 200 simple events versus 0.026 ms for none. This does not attribute all observability runtime to canonicalization.

Fix: sanitize incoming data once at explicit trust boundaries; retain immutable sanitized events internally and reuse unchanged projections by revision. Preserve redaction on all external/untrusted inputs. Benchmark begin/progress/finish costs at 0, 100, and 200 retained events and profile before changing semantics.

## Coverage and existing strengths

- Repository indexing/query workers, query concurrency limits, owner-aware host scheduling, build coalescing, and worker idle eviction already exist. Raising concurrency is not the first recommendation.
- Git text search streams results and can stop at the result bound. Read caches and ordinary command output have explicit limits.
- React routes and Monaco load lazily; store slices, memoization, clock-specific updates, and bounded activity history avoid several common broad-render issues. Activity still constructs every filtered row (up to 1,000); profile a full live table before deciding whether virtualization is worth the complexity.
- Browser/UI sessions and computer observation caches have explicit limits and cleanup. No unbounded screenshot-cache finding is asserted.
- Service bootstrap, routes, and disabled telemetry now use lazy-loading mechanisms. The older audit's eager-import finding is stale for those paths. Core startup still synchronously initializes/checks existing databases; loaded-state startup and packaged first paint remain unmeasured.
- Newly added task-history worker writes, smaller dashboard queries, and storage metrics are improvements observed during this review. They have not been independently release-validated here.

## Verification gaps and priorities

Run supported-runtime measurements on a stable commit before setting release thresholds. Add loaded-state dashboard/startup coverage, large single-file edits/additions/deletions, realistic graphs, sustained log output with slow disk, slow SSE readers, mature analytics months, and long active LSP sessions. Record event-loop delay, RSS, pending bytes, p50/p95/p99, and phase timings. Three execution samples and one index run at each size are insufficient for reliable tail latency.

The observability script was being revised while this audit ran, including replacement of JSON-directory write counters with SQLite metrics. Do not treat results from the earlier loaded script as verification of the newer instrumentation. The startup test measures fresh-state stdio initialization, not packaged Electron first paint or an existing large database. Its latest version now prints timings before assertions and gates the first tools list; that improvement was included in the passing startup run.

The renderer benchmark is a particularly important coverage gap: `test/fixtures/electron-observability-benchmark/index.js:20` loads an empty data-URL page and manually creates and updates DOM nodes. It does not mount the production React dashboard or dispatch through its store. Its zero full renders and 3.9 ms timeline creation therefore cannot detect production React rerender or layout regressions. Retain it as a primitive browser check, but add a benchmark loading the actual built dashboard with production event dispatch and full-size task/activity fixtures.

Suggested order: bound managed-process output memory; make incremental indexing genuinely scoped; move/normalize synchronous analytics and recent-event reads; remove repeated timeline work; then address LSP retention, synchronous spilling/scanning, and slow SSE delivery. Validate correctness and cancellation alongside performance throughout.

## Post-audit implementation status

The requested remediation pass was completed by three Luna agents. The nine findings above now have corresponding code changes:

- Incremental Repository Intelligence refreshes use targeted manifest and relationship queries, cache generation-scoped resolution metadata, and skip the full integrity check on the incremental path. The 100/200-file scaling smoke measured 14.87/15.38 ms (1.03x); a separate 10,000-file run reported about 153 ms versus the 663.89 ms pre-fix observation. These numbers remain workload- and machine-sensitive.
- Managed-process logs and command-output spills use asynchronous FIFO writes with byte watermarks. Pipe sources pause and resume around pressure; PTY output has an explicit bounded-drop policy and persisted dropped-byte counters.
- Mature analytics months update indexed counter rows and materialize the monthly document during flush/maintenance. Small documents retain the existing compact path.
- Recent task-history events are maintained in an indexed SQLite projection, so dashboard reads no longer expand every retained timeline for each request.
- LSP document reads check metadata before rereading unchanged files and evict least-recently-used documents at count/byte limits.
- Dashboard SSE delivery uses a bounded per-connection FIFO, honors `drain`, and closes overloaded clients for reconnect/resnapshot recovery.
- Non-Git mutation accounting uses asynchronous directory/stat operations with periodic event-loop yields.
- Task snapshots and activity projections reuse already sanitized event arrays at explicit trust boundaries to avoid redundant timeline passes.

Focused regressions, Repository Intelligence (22-file) coverage, HTTP/auth/dashboard smoke, analytics, task-history, LSP, process, spill, and SSE tests pass. `npm run lint`, `npm run typecheck`, and `npm run check:quick` pass. The startup budget test passes when run in isolation; concurrent benchmark processes can exceed its cold-start budget, so startup timing still needs a controlled supported-runtime run.
