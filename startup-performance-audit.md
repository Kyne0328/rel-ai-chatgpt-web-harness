# Startup and performance audit

Date: 2026-09-17. Scope: current working tree, including existing uncommitted changes. No application code changed.

## Measurements and limits

- `node test/mcp-startup-budget-unit.mjs`: FAILED. Three initialization samples produced a 5,220.10 ms median against the Windows 3,500 ms budget. The assertion prevents the test printing its remaining timing summary.
- Fresh-process `import('./src/httpServer.ts')`: 10,927.82 ms; process RSS after import 251.63 MiB. No HTTP listener was started by this probe.
- Fresh-process `import('./src/telemetry.ts')`: 1,479.98 ms; process RSS after import 67.16 MiB.
- Service-process-client and service-runtime-lifecycle unit tests: PASSED.
- Measurements used the shell's Node 24.13.1; package.json requires Node >=26.8.2 <27. These are local diagnostic observations, not supported-runtime release benchmarks. Import probes ran concurrently, so their elapsed times include possible contention and are not additive. RSS is whole-process memory, not module-exclusive allocation. No OS-cache-cold claim is made.
- No packaged Electron startup, actual tunnel connection, production database, or sustained load was measured. Findings below distinguish confirmed implementation behavior from workload-dependent impact.

## Findings

### 1. High: substantial eager imports precede service readiness

Evidence: electron/service-process.js:12 loads the HTTP server, desktop operations, desktop manager and browser driver before installing the parent message handler. src/httpServer.ts imports src/http/routes.ts, which statically imports dashboard, computer, diagnostics, extensions and MCP handlers. src/core/dashboard-runtime.ts imports repository intelligence and release operations. electron/desktop-host.js:71 also imports src/process.js before desktop.start(); that imports telemetry through src/process.ts. src/telemetry.ts:1-6 eagerly loads the tracing SDK/exporter even when telemetry is disabled.

Impact: the service start request's 30-second timer includes module loading, not just binding a socket. The HTTP import probe confirms material cost on this machine; the exact contributors need module-level profiling on the supported runtime. Controller-side eager loading also occurs before the first window is routed.

Recommendation: separate a minimal service bootstrap from optional route/tool implementations. Load optional implementations on demand, prewarm selected ones after readiness, and load the tracing exporter/provider only when enabled. Keep readiness honest about essential services. Instrument process spawn, module evaluation, configuration, database initialization, listen, first dashboard paint and tunnel readiness separately.

### 2. High: synchronous persistence can stall every request in the service

Evidence: src/taskHistoryStorage.ts:254 defines writeSessionAsync as a direct call to synchronous writeSession. src/taskHistoryStore.ts:663 flushes pending sessions through that wrapper. src/stateDatabase.ts:114-156 opens a DatabaseSync connection, configures schema/PRAGMAs, optionally begins an immediate transaction, then closes it for each operation. Its default SQLite busy timeout is 5 seconds.

Impact: deferred writes move the blocking work to a timer; they do not move it off the event loop. During slow storage or lock contention, MCP, dashboard, SSE and health handling share the stall. Awaiting already-resolved writes between sessions does not guarantee an I/O opportunity. Multi-session bursts can compound the delay. This mechanism is confirmed statically; a production stall was not reproduced.

Recommendation: put database ownership and writes in a dedicated worker, batch compatible writes in transactions, preserve durability acknowledgements, and measure event-loop delay plus lock-wait duration. Avoid merely increasing HTTP timeouts.

### 3. Medium: database checks make startup depend on retained data size

Evidence: src/httpServer.ts:63-69 calls coreRuntime.start before listen. src/core/runtime.ts:41-43 initializes both databases synchronously. src/stateDatabase.ts:192 and src/knowledgeStore.js:127 run assertSqliteIntegrity. src/sqliteDurability.ts:47-49 implements that as PRAGMA quick_check.

Impact: existing state and knowledge databases are traversed before readiness. A fresh-state benchmark does not cover growth, lock contention, migration, recovery or slower disks. The knowledge check is skipped when that database does not exist.

Recommendation: measure checks independently against representative existing databases. Perform required validation in a worker; retain integrity/recovery guarantees and expose an explicit initializing state. Consider a validated maintenance policy for deeper checks rather than silently dropping them.

### 4. Medium: timeout retries repeat expensive work and delay visible startup

Evidence: electron/service-process-client.js:3,14-15,46-48 gives spawn 10 seconds and start 30 seconds. electron/service-runtime.js:7-10,91-113 retries a start-request timeout once after 250 ms, with a fresh process. electron/desktop-host.js:854-864 waits for local readiness before creating the dashboard; first-run setup waits for the full start promise, including the tunnel. electron/secure-tunnel-runtime.js:10 gives tunnel startup another 30-second timeout.

Impact: two start-request timeouts alone consume roughly 60 seconds plus retry/spawn/cleanup overhead. Restarting repeats imports and initialization. Ordinary configured launches already decouple dashboard opening from tunnel readiness, which is good; first-run handoff still waits for the tunnel. The dashboard wait deliberately disables its own deadline with waitUntilListening(0), relying on lower-layer bounds.

Recommendation: display a lightweight startup window immediately, publish phase progress, and apply one end-to-end startup deadline. Retry confirmed transient failures; do not use process restart as the primary cure for consistently expensive initialization. Keep tunnel readiness separate from access to the local dashboard.

### 5. Medium: dashboard bootstrap performs fixed-size history work despite smaller requested limits

Evidence: src/core/dashboard-data.ts:62-66 raises the requested activity limit to at least 200 and loads 500 task summaries. src/taskHistoryStore.ts:249-292 loads MAX_SESSIONS (500), reconciles records and sorts before applying the caller's limit. src/taskHistoryStorage.ts:62-88 uses JSON operations on stored payloads and a write-capable immediate transaction for summary reads. src/taskHistoryStorage.ts:260-274 pruning selects every history payload before determining whether anything needs removal.

Impact: bootstrap/refresh cost depends on retained history and payload size, rather than the number of visible rows. Read-time reconciliation can schedule writes. Immediate transactions also contend with writers. This is bounded in normal retained history, but avoidable work still affects loaded-state startup.

Recommendation: use indexed summary fields and read-only list queries, paginate visible history, query active tasks separately, and move reconciliation/pruning out of dashboard requests. Prune from indexed status/time metadata rather than loading all payloads.

### 6. Medium: existing performance gates miss important regressions

Evidence: scripts/observability-benchmark.mjs:48-54 counts .tmp-to-.json renames under sessions, and lines 66-90 measure storage in the sessions directory. Current persistence writes durable-state.sqlite in the parent state directory. The queue-wait metric at line 89 is a literal zero. test/mcp-startup-budget-unit.mjs exercises stdio initialize/tools-list with temporary state, not Electron, HTTP startup, an existing large database, first dashboard paint or tunnel readiness. It records first-tools-list latency but asserts only initialize and warm-list medians.

Impact: history write/storage metrics can report zero while SQLite is doing substantial work. A passing stdio budget cannot establish acceptable desktop startup or first-use latency.

Recommendation: instrument actual SQLite transactions and bytes, include WAL/SHM storage, measure real scheduler events, and add supported-runtime cold/warm desktop and loaded-state HTTP benchmarks. Report samples before assertions; gate first-list and first-dashboard latency explicitly.

### 7. Environment: local CLI runtime does not match the project requirement

The default node.exe is Node 24.13.1, and the alternate bundled runtime found on PATH is Node 24.19.0. Neither meets this repository's Node 26 requirement. This does not establish the version embedded in packaged Electron and does not prove the cause of desktop slowness.

Recommendation: pin the supported development runtime and rerun the benchmark there before setting release thresholds or comparing optimizations.

## Suggested execution order

1. Correct benchmark instrumentation and establish a supported-runtime baseline with populated synthetic state.
2. Reduce eager controller/service imports and expose startup phase timings.
3. Move synchronous database work off the service event loop while preserving durability.
4. Narrow dashboard history queries and pruning.
5. Add immediate startup UI and one coherent startup deadline; evaluate retries using measured phase failures.

Acceptance should include initialization, first dashboard paint, first tool invocation, event-loop delay under concurrent persistence, and recovery with locked/large databases. Choose thresholds from representative supported hardware rather than the unsupported-runtime samples above.
