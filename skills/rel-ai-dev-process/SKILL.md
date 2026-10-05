---
name: rel-ai-dev-process
description: Use only when repository work requires a persistent development server, file watcher, long-lived preview, or interactive CLI that must stay alive across later steps. Do not use for one-shot tests, builds, linters, migrations, checks, diagnostics, or release gates.
---

# Rel.AI Development Process

Reuse an active `work_id` for the current meaningful user goal. If the persistent-process request is itself a new user goal, establish that goal through `relai_work begin` before project work; do not create an extra task merely to own or interact with a process. Process authority still comes from the authenticated principal, authorized workspace, and `processId`; an explicitly supplied work_id must match any existing task attribution. If `relai_process` returns `reused: true`, continue from that process's readiness/log state rather than starting a duplicate.

Use this process flow: `start with explicit purpose -> determine readiness -> inspect incremental output -> interact only if required -> reuse process -> stop when no longer needed`.

1. Confirm the command is genuinely persistent or interactive. Do not trigger for tests, builds, linters, source checks, release gates, or other one-shot commands; those belong in `relai_exec` or `relai_validate`.
2. Start it with `relai_process` action `start`, an explicit `kind` (`service`, `watcher`, or `interactive`), and a concrete `purpose` explaining why persistence is needed.
3. Determine readiness from startup output or a bounded HTTP probe before treating the process as usable.
4. Read logs incrementally with stdout/stderr offsets. Reuse `metadataRevision` after the first read so unchanged process metadata is not returned repeatedly.
5. Reuse the same live process while it still serves the objective. Write stdin only when an interactive program actually expects it.
6. When the runtime has produced enough evidence, return control to `rel-ai-debugging` for defect work or `rel-ai-verification` for proof instead of keeping process management as the active concern.
7. Choose `lifecycle: "task"` for a service owned exclusively by this work session and needed only until finish/cancel. This opt-in requires the matching `work_id`. Omitted lifecycle remains `persistent` for compatibility and must be stopped explicitly when no longer needed. Never claim ownership of a pre-existing/shared Gradle, Java, adb or emulator process by its name alone. Read [resource workflow guidance](../rel-ai-workflow/references/resources.md) for queue pressure and cleanup uncertainty.
8. Use `relai_exec` or `relai_validate` instead for one-shot tests, builds, checks, migrations that terminate, or release gates.
