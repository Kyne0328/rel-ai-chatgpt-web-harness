# Workflow reliability

Rel.AI exposes one canonical public tool surface and supplies repository facts, execution results, optional durable evidence, and hard runtime constraints. It does not maintain a second planner for ChatGPT. The agent chooses the shortest path and appropriate validation for the objective without weakening authorization, containment, resource ownership, collision protection, sensitive-path controls, or defined destructive approvals.

## Runtime authority

Start or reuse one durable `relai_work` session for each meaningful project goal handled through Rel.AI and carry that `work_id` through the objective. Every new durable task begins with a non-empty ordered plan supplied on `relai_work begin`; compact `taskProgress` patches update individual step status/details, while `relai_work plan` replaces the full plan only when its structure changes. Projectless one-shot utility/control requests run taskless through an already-supported operation and do not invent a workspace or durable task. Taskless calls also remain available for isolated control, recovery, observation, or resource operations. Rel.AI records factual evidence such as tool outcomes, validation fingerprints, workspace/task mutations, and process state. It does not return advisory `recommendedActions`, `avoidActions`, or synthetic workflow stages.

Authorization, workspace containment, sensitive-file policy, stale-write checks, workspace/task mutation generations, resource ownership, workspace conflicts, Git safety, and defined destructive approvals remain authoritative.

| Concern | Authority |
| --- | --- |
| Authorization, principal identity, workspace containment, sensitive-file policy | Existing runtime safety/authorization modules |
| Workspace/task mutations, mutation generations, validation freshness, and workspace conflicts | `src/taskIntegrity.ts` |
| Repository topology, package boundaries, check catalog | `src/workflow/topology.js` and `src/workflow/checkCatalog.js` |
| Safe evidence receipts | Existing durable task history |
| Process ownership and lifecycle | Existing managed-process runtime |
| Next repository action | The agent, based on current evidence and hard runtime constraints |

## Shortest-path examples

These are shapes, not required sequences. Skip any stage that current evidence already satisfies.

### Docs-only

For one isolated documentation correction, start a durable task with a compact proportional plan such as `targeted read -> edit -> review if useful`. Direct/taskless execution is reserved for projectless utility or control operations, not repository edits.

Documentation-only work normally does not justify package builds, repository-wide tests, Knip, security scans, or release checks unless repository policy or the changed documentation specifically requires them.

### Local bug fix

A localized correction still uses a compact durable plan. A bugfix that requires reproduction, diagnosis, mutation, and verification follows the shortest evidence-backed plan such as `reproduce or inspect -> coherent fix -> directly affected check -> review`.

Prefer the smallest check that proves the defect is fixed. Broaden only when the affected boundary or risk justifies it.

### Feature slice

Feature implementation is durable project work. Establish a proportional plan at task start, then follow the shortest evidence-backed shape such as `inspect/design only as needed -> implement coherent slice -> package-relevant checks -> review`, keeping one work_id through the objective.

Do not validate after every tiny edit. Validate at a meaningful implementation boundary and reuse exact fresh evidence when nothing relevant has changed.

### Investigation

A repository investigation is still a durable task and carries a proportional plan, even when it is read-only. Direct/taskless execution is reserved for projectless utility or control operations.

Investigation does not imply mutation or validation. Read and inspection evidence can be sufficient when the objective is explanatory.

### Risky release

Release work uses a durable plan. Use the shortest required shape such as `inspect release boundary -> focused regression proof -> required release/build/package checks -> review/publish`, keeping one durable work_id so ownership and publication scope remain attributable.

Release-wide validation is reserved for release, repository, cross-package, migration, dependency, contract, or other genuinely high-risk boundaries. It is not the default conclusion of a local source edit.

## Nested packages and repository topology

Rel.AI discovers package manifests below the configured repository root even when the root itself has no manifest. Nested packages receive stable path-qualified identities such as `npm:front-end` and `npm:back-end`.

Structured validation units carry both a command and package-relative `cwd`. A frontend-only change therefore runs frontend checks from the frontend package directory instead of silently invoking backend checks from the repository root. Identical command names in different package directories remain distinct validation units.

Topology discovery is bounded by depth, manifest count, and excluded generated/sensitive directories. Manifest metadata is cached by a repository-topology fingerprint rather than rescanned without limit on every tool call.

## Boundary and risk

Validation breadth is derived from the changed boundary and risk, not from file count alone. Many files inside one package can still be package-local. Shared contracts, dependency manifests, security/configuration surfaces, release workflows, migrations, and cross-package changes can widen the boundary or raise risk.

Boundary/risk helpers provide factual context for validation selection and reporting. The agent chooses what to run; existing integrity and safety owners enforce only their concrete runtime boundaries.

## Evidence reuse and freshness

Rel.AI stores safe evidence receipts in the existing durable task-history record. Receipts contain identifiers, outcomes, generations, safe paths, timing/status metadata, and repository fingerprints; they do not persist raw stdout/stderr, environment values, headers, credentials, or full tool arguments.

A passed validation result is reusable only when all of these still match exactly:

- structured check identity or command identity;
- normalized command;
- package-relative `cwd`;
- current repository fingerprint.

A changed repository fingerprint makes prior validation evidence stale. Mutation generation also separates retry epochs: repeated failures are counted only within the same task mutation generation. A new mutation resets the repeated-failure strategy.

When an exact passed receipt is fresh, Rel.AI reuses the proof without re-executing the command or replaying its old output. Connector results report executed and reused units separately.

Read evidence may also record bounded file hashes and line ranges. Search/context gathering can avoid rereading the same proven range only while the file hash still matches; it never uses that optimization as an access boundary or hard search filter.

## Edits and validation cadence

Edit shape and validation cadence are separate decisions. Use `relai_edit` for repository mutations and choose exact replacement, content replacement, patch text, or a bounded multi-file batch according to the change shape.

`runChecks` remains explicit. Rel.AI does not universally force validation after edits. The agent selects risk-matched checks when they are useful, and Rel.AI records the resulting evidence as passed, failed, stale, or not run.

For changed source, prefer directly affected tests first, then the cheapest package-relevant lint/type/test/build evidence needed for the boundary. Migration commands are never auto-selected as validation checks.

## Review scope

Task-scoped review defaults to files authoritatively owned by the current `work_id`. Ambient dirty files remain visible as excluded workspace changes but are not mixed into the task diff. Use `scope:"workspace"` only when the objective intentionally requires workspace-wide review.

Sensitive-file review keeps the existing redaction rules. Workflow guidance does not weaken them.

## Persistent processes

Use `relai_process` only for persistent services, watchers, previews, or interactive programs. One-shot tests, builds, linters, and scripts belong in `relai_exec` or `relai_validate`.

Rel.AI may reuse an active managed process only when its existing reuse fingerprint is compatible. Process access itself is authorized by principal + workspace + `processId`; `work_id` is optional attribution, and an explicitly supplied mismatched work_id is rejected rather than ignored. A reused result returns `reused:true` and current readiness state.

## Repeated failures

Rel.AI fingerprints safe failure facts such as tool/action identity, normalized command, `cwd`, error code, and safe target so repeated evidence can be recognized without persisting sensitive output. The agent decides whether repetition calls for diagnosis, repair, or another action. A new mutation starts a new evidence epoch.

## Inactivity and resumption

`inactive` is a non-terminal, resumable work-session state. A quiescent session keeps the same `work_id`, title, objective, counters, task-integrity state, task-owned changes, validation generations, and durable safe evidence. It receives `inactiveAt` but no terminal `endedAt`, `completedAt`, or `cancelledAt` timestamp.

A valid same-`work_id` call from the authorized principal in the bound workspace implicitly resumes the logical task into an active state. This is distinct from:

- explicit cancellation, which is terminal;
- explicit completion, which is terminal;
- a true terminal failure, which is terminal.

Historical records that used `inactivity_window` as cancellation/failure are normalized to resumable `inactive` when there is no explicit terminal action. Terminal sessions never reopen through inactivity handling.

## Completion and validation evidence

Validation evidence does not decide whether the agent may consider its objective complete. `src/taskIntegrity.ts` remains the factual authority for task/workspace mutations, ownership/conflicts, and whether recorded validation is current for the repository state. The workflow that owns the objective is responsible for closing its durable session; a verification specialist reports evidence and returns control to that workflow.

Use current structured validation when it helps prove the objective. Do not rerun an unchanged exact check merely to create ceremonial "final" verification. A successful `relai_validate` call records validation evidence and leaves the durable session open by default, including when `work_id` is supplied. `complete:true` explicitly requests atomic close after successful current validation. After remaining work is done, the owning workflow can use a final successful validation with `complete:true` to validate and close atomically. If validation fails, is cancelled, or becomes stale, it does not close the session; the owner can continue/revalidate or use `relai_work` with `action:"finish"` when the objective is considered complete despite the evidence, accurately reporting validation as failed, stale, not run, or not required.

A completed plan checklist or model statement cannot falsify Rel.AI's recorded evidence. Conversely, missing/stale/failed validation is evidence for the agent to evaluate, not a generic harness veto on completion.

## Observability and privacy

Rel.AI records bounded factual activity/evidence rather than a duplicate workflow planner. Durable task history is only created for explicit work sessions; taskless operations remain workspace/resource activity and must not manufacture "Planning" or "Inactive" tasks. Persistent evidence and dashboard projections exclude raw command output, environment values, headers, credentials, and other secret-bearing fields.

Ordinary evidence collection consumes existing authority facts and cached topology. It must not spawn a fresh global `git status` process after every read or other ordinary tool call.

## Recovery and publishing

Use `relai_changes` restore/reset/tidy actions only for the requested recovery scope. Publishing remains explicit through `relai_publish`; no evidence or planning helper commits or pushes automatically, and push targets are validated from the repository's actual Git remotes at execution time.

When executing an approved multi-step implementation plan, start a durable work session before the first project operation, including read-only planning or inspection, and keep that work_id through implementation and verification. Verify each completion condition and update checklists only when evidence proves it. Consolidate accumulated implementation as the plan advances instead of layering duplicate owners or compatibility paths.
