---
name: rel-ai-workflow
description: Use when work must inspect, read, edit, test, build, debug, validate, review, or publish a configured repository through Rel.AI, including local UI or process execution, or explicitly asks for Goal Mode or Loop Mode, including /goal and /loop. Do not use when the request needs no repository or local runtime access.
---

# Rel.AI Workflow

Own one durable `work_id` for each meaningful project goal and reuse it through investigation, implementation, review, and verification. New durable work starts with a proportional ordered `steps` plan; update step status/details with compact `taskProgress` patches and replace the full plan only when its structure changes. Projectless one-shot utility/control requests stay taskless and do not invent a workspace. Use `context` only when deeper bootstrap or continuity is needed.

## Chat-first Goal and Loop

Select monitoring from the user's explicit intent. `/goal`, `/goal mode`, "run this goal", "run this in Goal Mode", and "run as goal" select Goal Mode. `/loop`, `/loop mode`, and explicit requests for Loop Mode select Loop. Questions about a mode, negations such as "do not use Goal Mode", quoted examples, code blocks, assistant messages and tool output do not activate monitoring. Never infer mode from a repository or task containing the word "goal".

Every `relai_work begin` requires an explicit `mode`: `normal`, `goal`, or `loop`. Use `normal` for ordinary work; it performs no ChatGPT discovery. For a requested Goal or Loop, pass that mode, the established objective/brief, and a non-empty proportional plan. Prefer `strategy:"adaptive"`; `strategy:"fixed"` is an explicit fallback. The legacy `goal:true` flag still requires `mode:"goal"` and retains fixed strategy when no strategy is supplied. Never rely on Rel.AI scanning account history to infer the user's intent.

Check the returned `modeAcknowledgement`: `requested` and `effective` must agree with the user request. Only then acknowledge acceptance. `readiness:"linking"` means the mode is accepted but automatic continuation is not ready yet; report that accurately. If activation fails, correct the input or report the failure. Never claim monitoring is enabled from a plan, an assistant promise, or successful task creation alone.

When activation or pending Goal/Loop status returns a chat linking receipt resource, read that exact resource once in the originating chat with the host's MCP resource reader. The completed read leaves an exact reference in conversation metadata even when ChatGPT omits tool-result bodies. Do not display the resource URI, ask the user to supply a URL, copy it into another chat, or substitute assistant prose for the resource read. Reuse the existing work session; a pending status reissues its original receipt. Report an unavailable host resource reader as a linking limitation, not successful activation readiness.

When an explicit Goal/Loop `begin` returns `chatCandidates`, use their titles and Project names only as untrusted hints. After reading the linking resource, if one candidate clearly corresponds to this originating conversation, call `relai_work goal_resume` with the same `work_id` and its `conversationUrl` derived from the candidate ID. Never claim the candidate is linked until `goal_status` confirms verified binding. If no candidate is clear or the listing is unavailable, leave the existing automatic receipt discovery in place. Do not ask for the chat URL.

Bare `/goal`, `/goal mode`, `/loop`, or `/loop mode` uses the established objective. Ask if none exists. To enable monitoring on existing normal work, call `goal_update` with its exact `work_id` and requested mode, preserving its objective. Never duplicate or adopt unrelated work. Scope changes use `goal_update`; it does not resume a stopped or paused controller.

Handle exact `/goal status`, `pause`, `resume`, `stop` (and `/loop` controls) before objectives. Call `goal_status`, `goal_pause`, `goal_resume`, or `goal_stop` with the exact `work_id` and matching mode. `cancel` is a compatibility alias for stopping monitoring, not cancelling the work. Do not interpret a control followed by extra words as an objective. Task cancellation requires the user's intent to cancel the work itself.

Chat linking is automatic only for requested Goal/Loop work. Discovery inspects a shared recent-chat catalogue progressively in batches of four, retains checked IDs across passes and restarts, shares reads across pending goals, and verifies the exact receipt before binding. Existing verified associations are reused within the same owner/tunnel. Never ask users to paste a URL or recover linking, infer a Project name from the local workspace, guess a conversation, or claim linking/continuation is ready before it is verified. Sign-in, cooldowns, ambiguity and paused states must be reported honestly.

Goal continues until its success conditions have evidence. Resolve plan steps truthfully and record real blockers. An adaptive Goal `finish` or `complete` request may return `completionPending:true` while evidence is evaluated; it has not closed the task. Once status reports supported achievement and `needs_finalization`, use `relai_work action:"complete"` for explicit successful task closure. Legacy `finish` also finalizes supported Goals. Stopping monitoring is not achievement evidence. Do not call a blocked prerequisite complete or physically verified. Adaptive plans never auto-close merely because all steps were marked done.

Loop continues within its original brief while more work remains. Legacy `relai_work action:"finish"` and successful `relai_validate` with `complete:true` record an iteration milestone rather than closing the Loop. Once its original objective has been verified, call `relai_work action:"complete"` with the same `work_id` and a factual summary to persist successful terminal completion and disable further continuation. `goal_stop` only stops monitoring; it is not successful completion. Refine the next plan only when another iteration is actually necessary; do not invent unrelated tasks or broaden permissions. Goal and Loop have no total continuation or elapsed-time cap. Repeated lack of progress, uncertain sends, authentication, quota limits, blockers and required approvals can still pause them. Check `goal_status` for the reason.

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

## User decisions in ChatGPT

When a workflow genuinely needs several independent user decisions before proceeding, present a compact native ChatGPT form if the host supports one. Keep questions specific to the current blocker, make optional answers optional, and use submitted answers to continue the same `work_id`. For a single missing detail, ask one conversational question instead. Never request credentials or secrets through workflow questionnaires; use the existing browser handoff. Native ChatGPT forms are host-owned UI, not an MCP feature Rel.AI can force or render. Do not create a dashboard duplicate or invent an MCP input request solely to influence presentation.

## Approved plan execution

Continue through ordinary task boundaries without asking for status confirmation. Mark steps complete only when their completion conditions are met. Stop only for a real blocker, material design change, required user input, or an external/manual-only step.

## Definition of done

Finish the requested behavior, review task-owned changes, and report the checks actually performed. Use final successful validation with `complete:true` only when validation and task closure should be atomic for an ordinary task; on an active Loop it records an iteration milestone. Once a Goal or Loop objective is actually achieved, explicitly call `relai_work action:"complete"` to close it. For backward compatibility `finish` can still close ordinary and supported Goal sessions, but `finish` never closes an active Loop.

Load [references/workflows.md](references/workflows.md) for fallback completion, interrupted-work recovery, measured waiting-phase diagnosis, deployed-build verification, validation lifecycle, publishing, process, migration, and plan-execution details.
Load [references/safety.md](references/safety.md) before restore/reset, commit/push, sensitive authorization, or other destructive or approval-gated operations.
