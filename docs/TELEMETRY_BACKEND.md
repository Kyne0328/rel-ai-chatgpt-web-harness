# Rel.AI Telemetry Backend

Rel.AI's official telemetry backend is designed to operate on free managed tiers without running a VPS.

## Production architecture

```text
Rel.AI desktop
  |-- POST /api/v1/installation/presence --> Cloudflare Worker --> D1
  `-- POST /v1/traces --------------------> Cloudflare Worker --> Axiom
```

Production Worker:

`https://relai-telemetry.kynemcp.workers.dev`

The root package contains separate built-in usage and diagnostic endpoints. Those built-in endpoints are enabled only when the Electron host starts the service as an official packaged build. Source, development, and test runs do not use the production endpoints unless an explicit telemetry endpoint override is supplied.

## Data boundaries

### Mandatory installation presence

The client sends at most one successful report per 24 hours. The request contains only:

- schema version;
- random locally persisted installation UUID;
- Rel.AI version;
- operating-system platform; and
- CPU architecture.

The Worker rejects unexpected fields. D1 stores one row per installation with first/last seen timestamps and the current/first version. Repeated presence reports update that row instead of creating another installation.

### Optional diagnostics

Diagnostic traces use OTLP/HTTP and are on by default in official builds. Users can disable diagnostic telemetry in Settings.

The desktop never receives the Axiom credential. The Worker adds the Axiom authorization server-side and forwards the OTLP body to the `relai-diagnostics` dataset.

## Cloudflare resources

Worker name: `relai-telemetry`

D1 database: `relai-telemetry`

D1 region: APAC

D1 binding: `DB`

The Worker has three rate-limit bindings:

- `USAGE_RATE_LIMITER` for presence requests;
- `TRACE_RATE_LIMITER` for diagnostic batches; and
- `ADMIN_RATE_LIMITER` for administrator sign-in attempts.

Preview URLs are disabled. The stable `workers.dev` route remains enabled.

A daily cron runs at 00:15 UTC and writes a small aggregate snapshot to `daily_metrics`.

## Database schema

`installations` is the canonical installation registry:

- `installation_id`
- `first_seen_at`
- `last_seen_at`
- `first_version`
- `current_version`
- `platform`
- `architecture`

`daily_metrics` stores aggregate product trends:

- total installations;
- active 1/7/30 day installations; and
- new installations in the last day.

`admin_sessions` stores only hashed, expiring developer-console session identifiers. The browser receives the corresponding random identifier in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; the administrator password is never stored in browser storage.

Apply new migrations with:

```bash
npm run telemetry:migrate
```

## Deployment

Run focused telemetry tests:

```bash
npm run telemetry:test
```

Deploy:

```bash
npm run telemetry:deploy
```

Run the production smoke test after deployment:

```bash
npm run telemetry:smoke
```

The smoke test exercises health, presence deduplication, and the Axiom OTLP proxy, then removes its fixed synthetic installation row from D1. If `REL_AI_TELEMETRY_ADMIN_PASSWORD` is temporarily present in the local environment, it also verifies the private username/password admin login.

Worker secrets include `AXIOM_TOKEN`, `ADMIN_PASSWORD_SALT`, and `ADMIN_PASSWORD_HASH`. Set or rotate them with Wrangler's secret commands; do not put secret values in `wrangler.jsonc`, source code, Git, or a release artifact.

## Developer analytics

Open:

`https://relai-telemetry.kynemcp.workers.dev/admin`

The page itself contains no analytics data until you sign in with a username and password.

The production username is `admin`. The password is independent from Axiom and is verified against a salted SHA-256 hash. `ADMIN_PASSWORD_SALT` and `ADMIN_PASSWORD_HASH` are Cloudflare Worker secrets and must not be stored in `wrangler.jsonc`, source code, Git history, or release artifacts. To rotate the password, generate a new random salt and salted hash, replace both Worker secrets, then redeploy the Worker.

Signing in sends the password only to `POST /api/v1/admin/login`. A successful login creates an expiring server-side session and sets an `HttpOnly` cookie, so the page does not turn the password into a reusable browser token or persist a Basic authorization value in JavaScript storage. Selecting **Keep me signed in for 7 days** gives the cookie a seven-day lifetime; otherwise it is a browser-session cookie with a server-side 12-hour ceiling. `POST /api/v1/admin/logout` revokes the current session.

The admin page shows installation totals, active 1/7/30-day counts, new-install counts, version adoption, platforms, and CPU architectures. Diagnostic trace exploration stays in Axiom.

## Runtime overrides

`REL_AI_MAINTAINER_USAGE_ENDPOINT` overrides the built-in mandatory usage endpoint for development or validation.

`REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT` overrides the built-in official diagnostic endpoint.

A user-configured `telemetry.endpoint` continues to affect diagnostics only and cannot redirect the maintainer usage stream.

## Failure behavior

Telemetry is not part of Rel.AI's functional request path.

- Usage reporting failures do not block startup or tool execution.
- A failed presence report does not advance `lastReportedAt`.
- Diagnostic export failures do not fail the user operation being traced.
- If a free-service quota is unavailable, diagnostics are best effort rather than a reason to add a paid fallback automatically.

## Security and privacy checks

Before a release:

1. Run `npm run telemetry:test`.
2. Run the normal repository validation gates.
3. Confirm `GET /health` returns success.
4. Confirm a duplicate presence request updates only one installation row.
5. Confirm diagnostic OTLP reaches Axiom through the Worker.
6. Confirm no secret appears in `git diff`, committed files, or release artifacts.
7. Confirm source/dev runs report `usageReportingEnabled: false` unless an explicit override is present.
8. Confirm an official packaged Electron service receives `REL_AI_OFFICIAL_BUILD=1`.

If the Axiom token is ever exposed outside the intended secret store, rotate it and update the Cloudflare Worker secret.
