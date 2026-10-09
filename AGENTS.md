# Agent engineering and CI policy

Use the current repository, failing logs, tests, CI configuration and Git state as evidence. Do not treat past audit summaries as current truth.

## When fixing a failure

1. Start with the exact latest failing assertion, platform and owning test. Reproduce the smallest failing command first.
2. Identify whether the cause is product behavior, an overly rigid test, a race, or runner/infrastructure failure. Do not call a failure flaky without evidence.
3. Preserve legitimate behavioral, safety, security, concurrency, recovery and compatibility guarantees. Never fix CI by silently skipping failures or weakening those guarantees.
4. Prefer the smallest correction to the failing code or test oracle. Do not expand one failure into an architecture audit or add generalized helpers without need.
5. Replace sleeps, environment-specific string/snapshot assumptions and incidental implementation assertions with deterministic synchronization and observable behavior when that is the actual test contract.

## Keeping tests maintainable

- Add tests for meaningful behavior and regressions, not automatically one test file per implementation file or every internal detail.
- Extend an existing relevant suite unless isolation genuinely requires a new executable. Delete superseded tests and test-only scaffolding.
- Avoid pinning changing dependency versions, terminal banners, CSS coordinates, specific timestamps or internal command text as assertions unless they are genuine external contracts.
- Keep fixtures minimal and isolated; don't use production user data, unowned processes or live credentials.
- Distinguish fast required checks from expensive native/platform, browser, packaging and benchmark checks. Give expensive checks an explicit risk/release rationale.
- Don't run the same full suite twice for one commit unless verification is genuinely independent; avoid push plus pull_request duplication on the same branch, and never auto-launch publishing workflows for routine test edits.

## Validation and delivery

- After a fix, run the affected test, then the exact failing parent CI command on the relevant platform when possible. Run broad suites only if their production boundary changed or release checks require them.
- Do not rerun expensive passing suites without a new change or concrete reason.
- Report observed failure, root cause, corrective change, exact validation result and any checks not reproduced. Distinguish runner/tool failures from repository failures.
- Review only task-owned changes; never commit unrelated working-tree state. Do not push or publish without a request.
