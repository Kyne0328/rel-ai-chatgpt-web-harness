# Programmable tool composition

`relai_compose` runs bounded JavaScript that coordinates existing public Rel.AI
tools. Use it for parallel independent reads, dependent tool sequences, loops,
branching, and filtering results before returning them to ChatGPT. Direct tools
remain the shortest path for a single operation; reads, searches and edits also
retain their existing batch forms.

Start the normal durable work session for project work, then supply its `work_id`
to the composition. Projectless utility/control work may remain taskless. An
optional `workspace` sets the default project for children. A supplied work session
or workspace cannot be changed inside the script. Taskless compositions without
a default workspace can address individually authorized workspaces explicitly.

## Script API

- `tools.<publicName>(args)` returns a promise for that tool's normal structured
  result. Inspect `ok`, `errorCode` and the tool-specific evidence. Ordinary tool
  errors are returned as `ok:false`; JavaScript and bridge errors stop the script.
- `ALL_TOOLS` contains public names, descriptions, input schemas and annotations.
  It includes tools the current principal may not be authorized to execute; each
  invocation independently checks the live grant. Discovery is not permission.
- `text(value)` emits a string or JSON-serializable value. Intermediate values and
  the script's return value are not emitted.
- `image(value)` forwards an image returned by a nested tool. Pass its `image`
  object or native image content block. Invented image data and remote URLs are
  refused. Images are returned as native MCP image blocks.
- `LIMITS` exposes the immutable runtime limits. `tools` and `ALL_TOOLS` are also
  immutable. Each invocation starts a new interpreter with no persistent globals.

Top-level `await` is supported. Independent work can use `Promise.all`; await a
mutation before performing any action that depends on its result. Tools are called
through their ordinary public argument schemas, with `workspace` and `work_id`
inherited from the composition. There is no Node.js, filesystem, network, imports,
timers, console, or shell access inside the interpreter. Authorized commands still
run through `tools.relai_exec` and retain their normal host privileges.

Every promise returned by a tool must be awaited. Returning with outstanding tool
calls fails with `COMPOSITION_UNAWAITED_CALLS` and requests their cancellation.
`relai_compose` cannot recursively call itself. Task/Goal begin, finish, stop,
cancel, pause, resume and update controls must be direct tool calls outside the
composition. `relai_work` context, status, result, history and plan remain usable.
`relai_validate` with `complete:true` must also be direct so the composition cannot
try to finish its own still-running task.

## Examples

Parallel searches, with only selected results returned:

```javascript
const patterns = ['TODO', 'FIXME'];
const results = await Promise.all(patterns.map(pattern =>
  tools.relai_search({ pattern, glob: 'src/**' })
));
text(results.map((result, index) => ({
  pattern: patterns[index], ok: result.ok,
  matches: result.matches, error: result.error
})));
```

A dependent sequence:

```javascript
const edit = await tools.relai_edit({
  path: 'src/settings.js', oldText: 'enabled: false', newText: 'enabled: true'
});
if (!edit.ok) {
  text(edit);
  return;
}
text(await tools.relai_read({ paths: ['src/settings.js'] }));
```

The caller supplies these scripts as `code`, alongside `work_id` and optionally
`workspace`. `timeoutMs` sets the total deadline, from 100 to 120000 milliseconds;
the default is 60000. This deadline includes tool execution and queue admission.

## Limits and settlement

| Resource | Limit |
| --- | --- |
| Source | 128 KiB UTF-8 |
| JavaScript memory | 64 MiB |
| Active JavaScript CPU | 2 seconds; tool waits do not consume it |
| Wall time | 120 seconds maximum |
| Nested calls | 64 total, 8 concurrent |
| Arguments | 1 MiB per call |
| Tool results | 8 MiB per call, 32 MiB total |
| Emitted text | 128 KiB |
| Emitted images | 4 |
| Output | 64 items, 12 MiB total |
| Active interpreters | 4 globally, 2 per principal |

The QuickJS/WASM interpreter runs in a separate Node worker with its own V8 heap
and stack limits. CPU interruption and host wall-clock termination are independent.
Concurrent calls still acquire the canonical task/workspace queues. The outer
coordinator never holds a workspace queue on behalf of its children.

Cancellation or termination closes admission, stops the interpreter, and forwards
cancellation to children. The host gives admitted children up to five seconds to
settle their receipts before returning. Remaining calls are explicitly listed as
pending through `calls` and `unsettledCalls`; their ordinary task activity/recovery
owners remain authoritative. Capacity stays occupied until those calls settle,
preventing a fire-and-forget script from evading host limits. Long-lived services
started through `relai_process` retain that tool's declared lifecycle.

## Results and recovery

Results include `compositionId`, `outputs`, bounded call receipts, a summary, and
duration. Each receipt identifies the child tool/action, dispatch status, success
or failure, and returned execution/resource identities and mutation facts. Child
calls remain independently observable and auditable. A child failure makes the
aggregate `ok:false`, even if the script inspected or handled the failed result.

With a workspace or work session, explicit output and complete call receipts are
also retained in the existing private output store. `compositionOutputRef` points
to a versioned JSON document containing `outputs` and `calls`. Read it using
`relai_read` with `outputRef` and the same authorized workspace/work session.
Normal output-store size, retention and ownership limits apply. Task history
retains the reference and safe receipts instead of copying raw output or script
source. A background result recovered after restart may be a compacted projection;
use its output reference for the complete document. Images in that JSON retain
their original encoded data. Without a workspace or work session, output is only
available in the immediate bounded response.

The composition uses existing background execution admission, delivery and replay
handling. Children do not inherit the parent's background replay identity. No
script or child is automatically retried. A script error, timeout, cancellation,
output limit or interpreter termination does not roll back an admitted mutation.
Inspect receipts, current repository state and any pending recovery before retrying.

## Validation

`node test/composition-unit.mjs` exercises the isolated interpreter and canonical
dispatcher with temporary fixtures. It covers parallel/dependent calls, scope and
capability denials, mutation evidence, limits, cancellation, partial execution,
image transport, private output retention and background replay. The suite runs
in its own process because worker quotas and execution/task globals need isolation.
