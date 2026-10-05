---
name: rel-ai-workflow
description: Use when work must inspect, read, edit, test, build, debug, validate, review, or publish a configured repository through Rel.AI, including local UI or process execution. Do not use when the request needs no repository or local runtime access.
---

# Rel.AI Workflow

Own one durable `work_id` for each meaningful project goal and reuse it through investigation, implementation, review, and verification. New durable work starts with a proportional ordered `steps` plan; update step status/details with compact `taskProgress` patches and replace the full plan only when its structure changes. Projectless one-shot utility/control requests stay taskless and do not invent a workspace. Use `context` only when deeper bootstrap or continuity is needed.

## Shortest sufficient path

Choose the next action from current evidence; do not mechanically execute every stage.

- Documentation: `targeted read -> edit -> review if useful`.
- Bugfix: `reproduce/inspect -> smallest coherent fix -> directly affected check -> review`.
- Feature: `inspect/design as needed -> implement coherent slice -> risk-matched checks -> review`.
- Investigation: `search/inspect -> targeted evidence -> report`; edit only when implementation is requested.
- Release: `inspect boundary -> focused regression proof -> required build/package gates -> review/publish`.

Reuse fresh evidence and batch related reads, searches, edits, or checks when one call preserves the same semantics.

## Route specialists only when needed

Stay in this workflow unless one specialist condition is actually present:

- `rel-ai-planning`: architecture, sequencing, dependencies, or completion conditions are unresolved.
- `rel-ai-investigation`: the user needs evidence or an explanation, not a repair.
- `rel-ai-debugging`: concrete repository behavior is wrong and needs causal diagnosis or repair.
- `rel-ai-verification`: implementation already exists and needs completion or release proof.
- `rel-ai-dev-process`: a service, watcher, preview, or interactive CLI must remain alive across later steps.

Do not invoke specialists ceremonially. They return conclusions to this workflow instead of opening parallel goals.

## Tool boundaries

`relai_edit` changes repository files. One-shot tests, builds, linters, source checks, and release gates use `relai_exec` or `relai_validate`; `relai_process` is only for persistent or interactive programs. Use `relai_ui` for local browser-rendered QA and `relai_changes` for scoped review/recovery. Exact action contracts live at `relai://server/tool-surface`; do not copy full schemas or hard-coded tool counts into skills.

## Approved plan execution

Continue through ordinary task boundaries without asking for status confirmation. Mark steps complete only when their completion conditions are met. Stop only for a real blocker, material design change, required user input, or an external/manual-only step.

## Definition of done

Finish the requested behavior, review task-owned changes, and report the checks actually performed. Use final successful validation with `complete:true` only when validation and task closure should be atomic; otherwise finish the work session explicitly when the objective is complete.

Load [references/workflows.md](references/workflows.md) for fallback completion, interrupted-work recovery, measured waiting-phase diagnosis, deployed-build verification, validation lifecycle, publishing, process, migration, and plan-execution details.
Load [references/safety.md](references/safety.md) before restore/reset, commit/push, sensitive authorization, or other destructive or approval-gated operations.
