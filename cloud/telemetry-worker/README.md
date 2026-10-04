# Rel.AI telemetry edge

This Cloudflare Worker is the public telemetry edge for official Rel.AI builds.

- `POST /api/v1/installation/presence` accepts the mandatory privacy-bounded installation presence event. Official clients authenticate with a random installation-scoped bearer credential; D1 stores only its one-way hash.
- `POST /v1/traces` accepts authenticated optional OTLP diagnostic batches and proxies them to Axiom without exposing the Axiom credential to desktop clients.
- `GET /admin` is the private product-analytics surface. Sign in with username `admin`; the password hash and salt are Cloudflare Worker secrets and are independent from Axiom credentials.
- `GET /health` reports whether D1 is reachable.
- A daily cron prunes expired telemetry state and stores small rolling-window aggregate snapshots for trend history.

Worker secrets are `AXIOM_TOKEN`, `ADMIN_PASSWORD_SALT`, and `ADMIN_PASSWORD_HASH`. New admin password hashes use PBKDF2-SHA256; the verifier keeps legacy salted-SHA256 compatibility only so an existing deployment can be rotated without an outage. Never commit secret values or a local `.env` file.
