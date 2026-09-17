---
name: rel-ai-investigation
description: Use for read-only repository questions that need evidence, including architecture audits, feasibility studies, dependency or caller tracing, impact analysis, implementation-status checks, and proof of how something works. Do not use to implement fixes or for final completion or release verification of changes already made.
---

# Rel.AI Investigation

Reuse an active `work_id` if the investigation already belongs to a durable work session. For substantial or multi-step repository investigations, start `relai_work` with action `begin` before gathering evidence, even though the work is read-only. Only isolated read or inspection questions should stay directly at workspace scope without a task.
Decide whether another search, read, measurement, or broader boundary is useful from the investigation question and current evidence. Rel.AI supplies repository facts; the agent owns sufficiency judgment and should stop when the required proof exists.

1. State the question and define what would count as sufficient proof before gathering more context.
2. Escalate evidence in this order: `bootstrap -> search/inspect -> targeted reads -> bounded measurement -> broader reads only if required`.
3. Prefer symbol, reference, caller, search, runtime, or package evidence over broad file dumps. Reuse evidence that is still current.
4. Read only the files and ranges needed to verify the claim. Use bounded one-shot commands for reproducible measurements; never start a managed process for an audit command.
5. Stop when the required proof exists. More available context is not a reason to continue investigating.
6. Classify conclusions as observed, verified, inferred, or unresolved. Tie inferences to the evidence that supports them.
7. This skill does not edit. If implementation is also requested, hand the verified findings to `rel-ai-workflow` or `rel-ai-debugging` instead of restarting the investigation.
