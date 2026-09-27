---
name: rel-ai-planning
description: Use for non-trivial repository features, refactors, migrations, or multi-stage changes where architecture, sequencing, dependencies, or durable task tracking must be decided before implementation. Do not use for small localized changes with an already-clear implementation path.
---

# Rel.AI Planning

Reuse an active `work_id` for the current meaningful user goal. Durable-plan detail and specialist routing are separate decisions: every durable task has a proportional checklist, but this planning skill is needed only when architecture, sequencing, dependencies, or completion conditions are genuinely non-trivial. A straightforward multi-step bugfix can establish its compact durable plan directly under `rel-ai-workflow` without invoking this specialist. A goal may begin without a project, but repository planning must explicitly name an authorized workspace before inspecting local project state.

Use this skill only when architecture or sequencing is genuinely non-trivial. Do not trigger for small localized changes whose implementation path is already clear after targeted inspection.
Planning defines architecture, dependencies, completion conditions, and meaningful risks; it does not prescribe a fixed tool ritual. During execution, choose the next repository action from current evidence, the demonstrated boundary, and hard runtime constraints.

## Planning workflow

1. Use the existing bootstrap and inspect the current implementation before designing a replacement.
2. Choose the shortest coherent architecture that satisfies the current requirement. Reuse appropriate existing boundaries; do not add abstractions for hypothetical future needs.
3. Define ordered tasks with explicit completion conditions, dependencies, and the validation needed to prove each meaningful risk.
4. Keep plans compact and proportional. Durable tasks keep a checklist, but it should contain only meaningful completion boundaries rather than ceremonial tool-by-tool steps.
5. For a durable plan, update checkboxes as completion conditions are met. After Task N, perform cumulative consolidation across Tasks 1..N: remove duplication, collapse unnecessary layers, and keep the combined implementation simpler than the sum of its steps.
6. Separate repository-verifiable work from genuinely external or manual-only steps so execution does not stop for work the agent can complete itself.
7. Hand execution back to `rel-ai-workflow` with the chosen architecture, task order, completion conditions, dependencies, validation expectations, and any unresolved decisions.

## Replanning boundary

Do not reopen planning for ordinary implementation details. Replan only when new evidence invalidates the architecture, task ordering, dependencies, or completion conditions.
