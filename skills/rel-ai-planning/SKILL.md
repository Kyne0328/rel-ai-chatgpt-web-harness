---
name: rel-ai-planning
description: Use for non-trivial repository features, refactors, migrations, or multi-stage changes where architecture, sequencing, dependencies, or durable task tracking must be decided before implementation. Do not use for small localized changes with an already-clear implementation path.
---

# Rel.AI Planning

Reuse an active `work_id` when present. For substantial or multi-stage repository planning, start a durable work session before repository inspection so the plan and any later execution keep one identity. Small localized planning that needs only an isolated read may stay workspace-scoped without a task.

Use this skill only when architecture or sequencing is genuinely non-trivial. Do not trigger for small localized changes whose implementation path is already clear after targeted inspection.
Planning defines architecture, dependencies, completion conditions, and meaningful risks; it does not prescribe a fixed tool ritual. During execution, choose the next repository action from current evidence, the demonstrated boundary, and hard runtime constraints.

## Planning workflow

1. Use the existing bootstrap and inspect the current implementation before designing a replacement.
2. Choose the shortest coherent architecture that satisfies the current requirement. Reuse appropriate existing boundaries; do not add abstractions for hypothetical future needs.
3. Define ordered tasks with explicit completion conditions, dependencies, and the validation needed to prove each meaningful risk.
4. Keep small plans compact. Use a durable checkbox plan only when the work benefits from persistent multi-step tracking.
5. For a durable plan, update checkboxes as completion conditions are met. After Task N, perform cumulative consolidation across Tasks 1..N: remove duplication, collapse unnecessary layers, and keep the combined implementation simpler than the sum of its steps.
6. Separate repository-verifiable work from genuinely external or manual-only steps so execution does not stop for work the agent can complete itself.
7. Hand execution back to `rel-ai-workflow` with the chosen architecture, task order, completion conditions, dependencies, validation expectations, and any unresolved decisions.

## Replanning boundary

Do not reopen planning for ordinary implementation details. Replan only when new evidence invalidates the architecture, task ordering, dependencies, or completion conditions.
