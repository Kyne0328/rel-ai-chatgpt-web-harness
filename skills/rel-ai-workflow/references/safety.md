# Rel.AI Safety

## General rules

Work only inside an authorized configured workspace. Use `work_id` only when behavior genuinely depends on durable task identity or when its ownership/recovery benefits are useful. Do not create or resurrect a task merely to edit, execute, validate, observe, transfer an artifact, or access a resource when the public contract supports workspace/resource scope. Inspect relevant files before editing. Treat pre-existing changes as user-owned unless the task explicitly includes them. Use bounded reads, outputs, patches, and process logs.

## Authorization

Never bypass or simulate user consent. Workspace-wide reset and clearing the saved browser profile are not exposed through MCP because ChatGPT Web cannot render their former native approval flow. Do not substitute a conversational confirmation for authorization. Git push requires the `git:publish` client grant; local commits use their explicit path/addAll/sensitive-authorization contract without a second approval prompt.

## Destructive changes

Prefer focused edits or `relai_changes` action `restore` for listed tracked paths. Workspace-wide reset is no longer an MCP action; do not recreate it through a command as a shortcut around removed approval. Review existing uncommitted changes first.

### Parallel Git worktrees

Give each editing task a separate authorized worktree and record its path and starting commit. Before retiring one, stop its writers and check:

- `git worktree list --porcelain`: match the exact path and HEAD to the task record; verify ownership with the task owner. Leave the primary checkout, locked trees, and trees used by another task in place.
- In that worktree, run `git status --short --untracked-files=normal --ignored=matching --ignore-submodules=none`. Inspect staged and unstaged edits, untracked or ignored entries, and changed submodules locally. A directory entry can stand for many files; an ignored file is not necessarily disposable.
- For a detached HEAD, run `git for-each-ref --contains HEAD --format="%(refname)" refs/heads refs/tags`. Empty output means no local branch or tag retains that commit. A clean working tree does not establish that the result was delivered.

Verify the intended work in its destination or a recoverable copy, including any files not tracked by Git. A review checkpoint is not a backup. If ownership, preservation, or authorization is uncertain, leave the worktree in place. Do not force removal.

## Command execution

Use `relai_exec` for bounded one-shot development commands and `relai_process` for persistent or interactive commands. Do not use either as an unrestricted command router. Respect configured workspace, environment, timeout, output, cancellation, and process-tree limits. If a finite task operation stalls, prefer `relai_work` action `stop` for the specific `operationId` when known, or omit `operationId` to stop the task's current finite operations while leaving the task open. Use `cancel` only when the logical task itself should end; managed persistent processes are stopped separately with `relai_process`. A successful command and a validation result are different evidence types. Use `relai_validate` when structured validation evidence is useful; neither is a universal permission prerequisite for completion.

## Commit, push, and pull requests

Review changes before publishing. Commit only the intended paths. Sensitive files require explicit scoped authorization naming every sensitive path and a reason. Push only to an allowed remote and branch after approval. Pull-request drafting is local text generation and does not create or publish a remote pull request.

## Uncertainty

When scope, ownership, or approval is unclear, inspect status and return the uncertainty. Do not broaden paths, infer consent, falsify validation freshness, or replace a refused operation with a more destructive one.
