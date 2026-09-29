# Rel.AI telemetry edge

This Cloudflare Worker is the public telemetry edge for official Rel.AI builds.

- `POST /api/v1/installation/presence` accepts the mandatory privacy-bounded installation presence event and stores one durable row per installation in D1.
- `POST /v1/traces` proxies optional OTLP diagnostic traces to Axiom without exposing the Axiom credential to desktop clients.
- `GET /admin` is the private product-analytics surface. Sign in with username `admin`; the password is verified against the salted hash configured in `wrangler.jsonc` and is independent from Axiom credentials.
- `GET /health` reports whether D1 is reachable.
- A daily cron stores small aggregate snapshots for long-term trend history.

The only Worker secret is `AXIOM_TOKEN`. Configure it with `wrangler secret put AXIOM_TOKEN`. Never commit the token or a local `.env` file.
