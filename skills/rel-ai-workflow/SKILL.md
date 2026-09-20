---
name: rel-ai-workflow
description: Use when work must inspect, read, edit, test, build, debug, validate, review, or publish a configured repository through Rel.AI, including local UI or process execution. Do not use when the request needs no repository or local runtime access.
---

# Rel.AI Workflow

This is the routing skill for repository work. Start or reuse a durable `work_id` for substantial or multi-step repository work before the first project operation, including read-first investigation, implementation, and final verification. `begin` is the only routine setup call: inspect directly afterward and use `context` only when deeper continuity/bootstrap evidence materially helps. Batch independent paths, ranges, or search queries in one call. For multi-step work, attach `taskProgress` to supported task calls to establish or advance the checklist without a separate plan round trip. Report only checklist state already true when a call starts: use `in_progress` for work that call is about to perform, then mark it completed on a later call or final finish. Isolated reads and small one-shot operations may stay workspace-scoped without a task. Reuse an active work session instead of opening another merely for a tool call.

## Shortest sufficient path

The agent chooses the next action and validation from current evidence. Do not mechanically execute every stage.

- Documentation: `targeted read -> edit -> review if useful`.
- Bugfix: `reproduce/inspect -> coherent fix -> directly affected check -> review`.
- Feature: `inspect/design as needed -> implement coherent slice -> risk-matched checks -> review`.
- Investigation: `search/inspect -> targeted evidence -> report`; edit only when implementation is requested.
- Release: `inspect boundary -> focused regression proof -> required build/package gates -> review/publish`.

Reuse fresh evidence instead of repeating the same read, check, review, or process start. When fallback work continues after a response, keep doing independent work and consume its later `completedOperations` notice instead of polling `status`.

## Route specialists only when needed

- Clear localized change: stay in this workflow.
- Non-trivial feature, refactor, migration, or dependent multi-stage work: `rel-ai-planning`.
- Architecture audit, feasibility study, dependency tracing, or evidence question: `rel-ai-investigation`.
- Reproducible error, crash, broken test, regression, or contract failure: `rel-ai-debugging`.
- Persistent service, watcher, preview runtime, or interactive CLI: `rel-ai-dev-process`.
- Completion proof, release readiness, or explicit final verification: `rel-ai-verification`.

Specialists return conclusions here; invoking every specialist for every objective is an anti-pattern.

## Tool boundaries

`relai_edit` changes repository files. One-shot tests, builds, linters, source checks, and release gates belong in `relai_exec` or `relai_validate`; `relai_process` is for persistent services, watchers, previews, or interactive programs. If one finite operation is stuck but the task should continue, use `relai_work` action `stop` for that operation (or all current finite operations) instead of cancelling the whole task. `relai_ui` supplies local browser-rendered QA, and `relai_changes` supplies review/recovery. Exact current action fields and execution classes are available from `relai://server/tool-surface`; do not copy full schemas or hard-coded tool counts into skills.

## Approved plan execution

When the user has approved a multi-task plan, continue through ordinary task boundaries without status confirmation. Update plan checkboxes only when their completion conditions are satisfied. Stop only for a genuine blocker, a material design change, required user input, or an external/manual-only step.

## Definition of done

Complete the requested behavior from current evidence and report the checks actually performed. A successful `relai_validate` checks call with an explicit `work_id` closes that durable task by default; use `complete:false` only when more task work intentionally remains. Use explicit finish only when completion is appropriate without a final checks call, and cancel only when the task is being abandoned.

Load [references/workflows.md](references/workflows.md) for uncommon publishing, recovery, migration, process, and plan-execution details.
Load [references/safety.md](references/safety.md) before restore/reset, commit/push, sensitive authorization, or other destructive or approval-gated operations.
