# Resource-aware execution

## Admission and responsiveness

Use one-shot exec/validate for finite builds, tests, linters and bounded diagnostics. Use managed processes for emulators, development servers, continuous log streams and watchers. A managed process makes ownership and stopping visible; it does not reduce that program's own RAM.

Heavy admission is bounded separately from lightweight reads and stop/status control. Proven read-only validation commands use the same lightweight classification as exec, while validation freshness checks remain intact. Optional cached graph enrichment may return explicit unavailable/deferred metadata under pressure; this does not mean the repository is empty. Prefer bounded text/read tools rather than repeatedly forcing an optional index lookup. Host admission queues reflect occupied concurrency slots, not physical-memory or commit-headroom measurements. Inspect the existing operation and diagnostics instead of launching duplicate work. Queue timeout/cancellation before spawn is not a failed build. Preserve the exact operation ID. Do not increase concurrency limits to hide a wait.

Host memory counters are diagnostic-only. Physical-memory, commit-headroom, reservation estimates, and missing or stale samples do not delay admission or execution. Heavy concurrency defaults to one through four operations, depending on available parallelism; it is not an OS-enforced memory quota. A launcher can create many internal workers. Use a project's supported Gradle/JVM/test-worker limits when the user authorizes that configuration. A Node old-space limit bounds one V8 heap, not process RSS or an entire descendant tree. Never promise that concurrency admission prevents all memory exhaustion; unrelated programs and post-start growth still matter.

## Ownership and cleanup

Explicit task lifetime requires a work_id already bound to the same workspace and means this work exclusively owns the managed process until finish/cancel. Existing and default managed processes remain persistent for compatibility. Same-task reuse must preserve the declared lifetime; cross-task sharing must not be inferred.

Stop only a verified managed identity or authorized owned process tree. Root exit, a missing PID, and a stop request are not proof all descendants exited. Preserve unknown termination and cleanup evidence. Task completion must not claim fresh validation if shutdown changed the workspace. Do not kill Java, Gradle, adb, emulator, or a port owner by name. Gradle daemons can be shared and intentionally survive a finite build. A global gradle --stop is not task-scoped cleanup.

## Repository accounting

Prefer structured edits and exact changed paths for known edits. Prefer read/search connectors or direct executable+argv for inspection. A narrowly recognized no-profile PowerShell/cmd form can use the lightweight path; arbitrary scripts, Get-* prefixes, aliases, redirection and command substitution do not establish read-only behavior.

Repository state is an immutable observation of one point in an operation. Share it only before another mutation, validation command, shutdown or index/branch change. Never reuse a pre-execution status as post-execution evidence. Do not treat a display-truncated changedFiles list as full ownership.

Integrity paths retain exact untracked file enumeration. Summary-only UI may use collapsed directories, but it cannot substitute for file-level ownership/cleanup. Rename tracking includes old and new paths. Git does not report ignored file contents.

Arbitrary commands in non-Git workspaces do not trigger filesystem discovery crawls. A command can succeed while mutationTracking is unavailable and mutationUnknown is true. The internal result has changedFiles: []; the compact public result omits the empty changedFiles field. Neither an empty list nor an omitted field proves no writes or owned cleanup paths. Prefer exact structured mutations when attribution is required. Explicit filesystem comparison helpers retain finite entry/time budgets and coverage reasons; partial scans, excluded paths, filesystem errors and Git failures remain unknown coverage. A command's cwd is not write confinement and must not silently narrow the workspace boundary.

## Generated content and Git tuning

Use REL_AI_EPHEMERAL_DIR for disposable task scratch. Tools must actually be pointed there; injecting the variable does not relocate their output. Keep reusable Gradle/SDK caches in stable configured locations and durable artifacts in documented destinations. Do not automatically move or delete ROMs, APKs, emulator data or outputs.

Offer project-specific ignore patterns only after inspecting intended tracked files. For Android, typical candidates are the particular project's .gradle and generated module build directories. ROM extraction trees and binaries may be the deliverable. Test narrow patterns with git check-ignore and ensure source/config/fixtures remain visible. No universal ignore template is applied automatically.

Do not enable fsmonitor or untrackedCache automatically. Rel.AI's hardened Git path disables configured fsmonitor hooks. A future built-in fsmonitor opt-in needs compatible Git versions across all clients, local filesystem checks, daemon lifecycle/cost measurements, and status-equivalence tests. Untracked cache needs the Git filesystem compatibility test. Preserve anti-hook hardening. Network mounts and submodules need separate evidence.

## Measurement and limits

Diagnostics distinguish current-process RSS/heap/external memory from system commit and physical memory. Authenticated local-dashboard diagnostics can measure up to 20 authorized managed roots on Windows: private bytes and working set are attributed only after exact creation-identity checks before and after sampling. Unknown, inaccessible, stale or reused identities have no attributed byte values. Root measurements are not a complete detached-descendant or app-family total; no global command-line inventory is collected. RSS is not Windows private commit or total app-family usage. Samples/trends do not by themselves prove a leak. Profile repeated cold/warm/idle workloads before evicting retained state; cache purges can make builds and indexing slower.

Performance gates must separate deterministic work counts from noisy latency. Compare cold/warm, dirty/untracked/ignored and non-Git fixtures, rename/delete, truncation and failure coverage. Record hardware/runtime and p50/p95. Do not report a universal 2x status improvement from one clean-tree sample or claim installed-runtime improvements from source-only tests.
