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

The client normally refreshes presence about every 12 hours, scheduled from the last successful report rather than process start time. The request contains only:

- schema version;
- random locally persisted installation UUID;
- Rel.AI version;
- operating-system platform; and
- CPU architecture.

The Worker rejects unexpected fields. The client also generates a random installation-scoped bearer credential. D1 stores only its SHA-256 hash alongside the installation row; the plaintext credential remains in Rel.AI-owned local state. Repeated authenticated presence reports update the existing row instead of creating another installation. Legacy rows without a credential hash are enrolled on their next valid client report.

### Optional diagnostics

Diagnostic traces use OTLP/HTTP and are on by default in official builds. Users can disable diagnostic telemetry in Settings. Command-bearing spans keep the complete command text so diagnostics remain useful; common credential-bearing values are redacted before export without truncating the command. Complete commands remain user-controlled text, so they can still contain project paths, inline code, SQL, literal arguments, or secret formats that do not match the redaction rules. Tool spans include the durable Rel.AI `work_id` when one exists.

Official diagnostic uploads authenticate with the same installation-scoped credential used for presence, plus the installation UUID in an edge-only header. The Worker validates that pair against D1, strips client headers, adds the Axiom authorization server-side, and forwards only the OTLP body to the `relai-diagnostics` dataset. The desktop never receives the Axiom credential.

## Cloudflare resources

Worker name: `relai-telemetry`

D1 database: `relai-telemetry`

D1 region: APAC

D1 binding: `DB`

The Worker uses layered rate limits with substantial headroom above normal client traffic:

- `USAGE_IP_RATE_LIMITER`: 120 presence requests/minute per source IP;
- `ENROLL_RATE_LIMITER`: 20 new or legacy installation enrollments/minute per source IP;
- `USAGE_RATE_LIMITER`: 30 authenticated presence requests/minute per installation;
- `TRACE_IP_RATE_LIMITER`: 600 diagnostic batches/minute per source IP;
- `TRACE_RATE_LIMITER`: 240 authenticated diagnostic batches/minute per installation; and
- `ADMIN_RATE_LIMITER`: 10 administrator sign-in attempts/minute per source IP.

A normal Rel.AI installation reports presence about twice per day and the OpenTelemetry batch processor normally exports far below these ceilings. The limits are abuse controls, not throughput targets.

Preview URLs are disabled. The stable `workers.dev` route remains enabled.

A daily cron runs at 00:15 UTC and writes a small aggregate snapshot to `daily_metrics`.

## Database schema

`installations` is the canonical retained installation registry:

- `installation_id`
- `first_seen_at`
- `last_seen_at`
- `first_version`
- `current_version`
- `platform`
- `architecture`
- `ingest_token_hash`

Rows are removed after 400 days without presence. `daily_metrics` stores aggregate product trends and is retained for 730 days:

- total installations;
- active 1/7/30 day installations; and
- new installations in the last day.

`admin_sessions` stores only hashed, expiring developer-console session identifiers. The browser receives the corresponding random identifier in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; the administrator password is never stored in browser storage.

Apply new migrations with:

```bash
npm run telemetry:migrate
```

## Deployment

The ingest-credential cutover is intentionally phased so installed clients are not broken by a stricter edge before they know how to authenticate:

1. Ship the client release that creates and sends the installation-scoped ingest credential while the existing Worker is still compatible with the extra headers.
2. Allow the updated client to reach the intended installed population.
3. Apply the D1 migration with `npm run telemetry:migrate`.
4. Deploy the authenticated Worker with `npm run telemetry:deploy`.
5. Run the production smoke test and confirm unauthenticated presence/trace requests are rejected.

Do not deploy the authenticated Worker ahead of the client release: older installed clients do not have an ingest credential and would lose maintainer presence/diagnostic delivery until updated.

Run focused telemetry tests before the cutover:

```bash
npm run telemetry:test
```

Deploy only at the server-cutover stage:

```bash
npm run telemetry:deploy
```

Run the production smoke test after deployment:

```bash
npm run telemetry:smoke
```

The smoke test exercises health, authenticated presence enrollment/deduplication, and the authenticated Axiom OTLP proxy, then removes its randomly generated synthetic installation row from D1. If `REL_AI_TELEMETRY_ADMIN_PASSWORD` is temporarily present in the local environment, it also verifies the private username/password admin login.

Worker secrets include `AXIOM_TOKEN`, `ADMIN_PASSWORD_SALT`, and `ADMIN_PASSWORD_HASH`. Set or rotate them with Wrangler's secret commands; do not put secret values in `wrangler.jsonc`, source code, Git, or a release artifact.

## Developer analytics

Open:

`https://relai-telemetry.kynemcp.workers.dev/admin`

The page itself contains no analytics data until you sign in with a username and password.

The production username is `admin`. The password is independent from Axiom. New hashes use PBKDF2-HMAC-SHA256 with 210,000 iterations and encode the algorithm and iteration count in `ADMIN_PASSWORD_HASH`. The verifier still accepts the previous salted-SHA256 format only so an existing deployment can be rotated without an outage. `ADMIN_PASSWORD_SALT` and `ADMIN_PASSWORD_HASH` are Cloudflare Worker secrets and must not be stored in `wrangler.jsonc`, source code, Git history, or release artifacts. Rotate the production secret to the PBKDF2 format before treating the password-hardening migration as complete.

Signing in sends the password only to `POST /api/v1/admin/login`. A successful login creates an expiring server-side session and sets an `HttpOnly` cookie, so the page does not turn the password into a reusable browser token or persist a Basic authorization value in JavaScript storage. Selecting **Keep me signed in for 7 days** gives the cookie a seven-day lifetime; otherwise it is a browser-session cookie with a server-side 12-hour ceiling. `POST /api/v1/admin/logout` revokes the current session.

The admin page shows the retained installation registry, installations seen in rolling 1/7/30-day windows, rolling new-install counts, version adoption, platforms, and CPU architectures. These are service-presence measurements, not DAU/WAU/MAU product-engagement metrics. The daily chart contains rolling-window snapshots captured at 00:15 UTC. Diagnostic trace exploration stays in Axiom.

## Retention

- Raw D1 installation rows: 400 days after last presence.
- D1 daily aggregate rows: 730 days.
- Expired admin sessions: removed by daily maintenance and opportunistically during login.
- Axiom diagnostic traces: the Rel.AI policy target is 30 days. Dataset retention is an external provider setting and must be configured and verified separately; repository code cannot enforce it.

## Runtime overrides

`REL_AI_MAINTAINER_USAGE_ENDPOINT` overrides the built-in mandatory usage endpoint for development or validation.

`REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT` overrides the built-in official diagnostic endpoint.

A user-configured `telemetry.endpoint` continues to affect diagnostics only and cannot redirect the maintainer usage stream.

## Failure behavior

Telemetry is not part of Rel.AI's functional request path.

- Usage reporting failures do not block startup or tool execution.
- A failed presence report does not advance `lastReportedAt` and is retried later.
- Diagnostic export failures do not fail the user operation being traced.
- Local telemetry status distinguishes configured/enabled state from exporter initialization and records the latest delivery success/failure timestamps when available.
- If a free-service quota is unavailable, diagnostics are best effort rather than a reason to add a paid fallback automatically.

## Security and privacy checks

Before a release:

1. Run `npm run telemetry:test`.
2. Run the normal repository validation gates.
3. Confirm `GET /health` returns success.
4. Confirm an authenticated duplicate presence request updates only one installation row and an invalid credential is rejected.
5. Confirm authenticated diagnostic OTLP reaches Axiom through the Worker and unauthenticated batches are rejected.
6. Confirm the production admin password hash has been rotated to the `pbkdf2-sha256$...` format.
7. Confirm the Axiom dataset retention is 30 days.
8. Confirm no secret appears in `git diff`, committed files, or release artifacts.
9. Confirm source/dev runs report `usageReportingEnabled: false` unless an explicit override is present.
10. Confirm an official packaged Electron service receives `REL_AI_OFFICIAL_BUILD=1`.

If the Axiom token is ever exposed outside the intended secret store, rotate it and update the Cloudflare Worker secret.
