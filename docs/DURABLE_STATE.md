# Durable State Architecture

Rel.AI deliberately uses more than one persistence mechanism. Storage is chosen by ownership, recovery semantics, and whether the data is authoritative or derivable. Do not move state into `durable-state.sqlite` merely because it is machine-written.

## Canonical storage map

| State | Storage | Reason |
| --- | --- | --- |
| Task history | `durable-state.sqlite` | Authoritative task lifecycle history; transactional with other task state. |
| Task session policy | `durable-state.sqlite` | Machine-owned policy state keyed by workspace/task. |
| Local analytics | `durable-state.sqlite` | Small structured machine-owned counters; no separate JSON engine. |
| Task/workspace integrity ownership | `durable-state.sqlite` | Safety-critical ownership and validation generations can change together and must commit atomically. |
| Learned validation affinity | `knowledge/knowledge.sqlite` | Durable learned state with a specialized lifecycle; remains independent of core task state. |
| Repository intelligence graph/index metadata | Per-repository intelligence database | Derived from repository source; rebuild rather than restore from the core durable-state backup. |
| Zoekt/search indexes and other generated indexes | Derived/cache files | Regenerable from source. |
| User configuration | User-readable configuration file | Users and tooling need a portable, inspectable config surface. |
| Desktop credentials | Electron `safeStorage` protected payload | Secrets stay behind OS-backed credential encryption rather than general SQLite/file state. |
| Request-state signing key | Restricted runtime key file (`0600`) | Needed by non-Electron CLI/stdio runtime; not a user credential and cannot depend on Electron `safeStorage`. |
| Onboarding, connection generations, desktop preferences, update policy cache | Atomic JSON files with validation/backups where durable | Small independent documents do not need relational transactions. |
| Audit log | Append-only file | Operational evidence is log-shaped and already has an explicit flush boundary. |
| Managed process recovery records | Files | Process recovery records are independent artifacts and are cleaned with process lifecycle. |
| Managed skills | Files/directories | Skills are portable text artifacts with their own atomic directory replacement semantics. |
| Validation plans, tidy plans, fallback execution records | TTL files | Short-lived workflow capability/recovery records; not long-term durable state. |
| Output spills and write staging | Derived/ephemeral files | Bounded transient payloads; safe to expire or regenerate. |

## SQLite policy

`durable-state.sqlite` and `knowledge/knowledge.sqlite` use WAL mode and explicit schema versions. Schema upgrades must be ordered migrations inside an immediate transaction. Existing non-empty-version databases get a verified pre-migration backup before mutation. A database whose schema version is newer than the running binary is rejected rather than downgraded.

Multi-row authoritative changes must use one transaction. In particular, task authority and workspace ownership updates must not be split across separate commits. Single-purpose file stores should use the existing atomic file helpers instead of introducing a database solely for consistency of style.

## Integrity, backup, and corruption behavior

On startup, existing durable databases are opened and checked with SQLite `quick_check`. On clean production shutdown, pending task history, analytics, audit, process, and UI work is flushed first; SQLite WAL state is then checkpointed, integrity-checked, and copied to a verified last-known-good `.bak` snapshot with `VACUUM INTO`.

If a durable SQLite primary is corrupt and a verified backup exists, startup preserves the corrupt primary as `*.corrupt-<timestamp>` and restores the verified backup. If no verified backup exists, startup fails rather than silently creating an empty replacement. Backup restoration never treats derived repository indexes as authoritative recovery sources.

## File durability policy

Durable JSON documents use `readJsonFile` / `writeJsonAtomic` (or the async equivalents) with schema validation and backups when loss would affect user-visible state. Direct `writeFile` is appropriate only for intentionally transient/derived data or for specialized append/staging flows with their own recovery contract.

Secrets are not moved into general JSON/SQLite storage. Desktop credentials remain protected by Electron `safeStorage`. Regenerable caches and indexes should be deleted/rebuilt when invalid rather than backed up as authoritative data.

## Shutdown order

Production HTTP and stdio shutdown use this order:

1. Stop accepting/finish transport work.
2. Flush task history, analytics, audit, managed-process/UI lifecycle work, and telemetry.
3. Checkpoint durable SQLite WAL files.
4. Run SQLite integrity checks.
5. Refresh verified last-known-good backups.

Do not run database backup concurrently with writers that are still flushing.
