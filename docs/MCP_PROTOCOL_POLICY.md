# MCP Protocol Policy

## Version boundary

- Modern MCP protocol for ordinary requests: `2026-07-28`.
- Stateless ChatGPT HTTP startup compatibility: `2025-11-25` (`initialize` and `notifications/initialized` only).
- Release/tool schema version: `7`.

The HTTP compatibility path exists because supported ChatGPT clients may still use the SDK-supported stateless startup lifecycle before ordinary MCP requests. Only `initialize` and `notifications/initialized` remain on that path. Authentication, principal construction, request budgets, telemetry, tool policy, workspace ownership, and explicit work-session identity remain shared with the modern transport.

The startup shim is protected by the HTTP/ChatGPT smoke tests, while stdio tests verify that stdio remains modern-only. Strict modern headers and ordinary-request cutover behavior are protected separately.

**Removal condition:** remove the remaining `2025-11-25` startup lifecycle shim only after supported ChatGPT clients no longer require it and packaged connector acceptance proves modern startup end to end.

## Supported model

- Stateless `server/discover` negotiation for modern HTTP and stdio clients.
- Stateless HTTP `initialize` and `notifications/initialized` compatibility for ChatGPT startup only. All ordinary tool, resource, prompt, and Events operations require modern MCP `2026-07-28` requests.
- Stdio through the MCP SDK.
- Bearer-authenticated private HTTP MCP at `POST /mcp`.
- `MCP-Protocol-Version`, `Mcp-Method`, and matching per-request `_meta` on modern requests.
- Optional client implementation metadata and required per-request client capabilities.
- No `MCP-Session-Id` or HTTP transport-session persistence.
- Host/Origin validation for the private local HTTP service.
- One principal-bound Rel.AI `work_id` per independent repository objective.
- Direct completion for clearly bounded operations and safe background continuation for long or indeterminate eligible work that outlives the direct response window.
- MCP Events on modern authenticated HTTP through `events/list`, `events/subscribe`, and `events/unsubscribe`; webhook callbacks are public HTTPS endpoints, verified before storage, signed with Standard Webhooks headers, and used only for high-signal terminal work/operation/process events.
- No MCP Apps helper tools, `ui://relai/*` resources, or in-chat task dashboard. The 15 coding tools remain the complete MCP tool surface; the Rel.AI desktop app owns human-facing task/process observability and control.
- Client implementation metadata is observational only. ChatGPT, Codex, Responses API, Agents API, or any future client name must not select a different tool surface or authorization path.

### Long-operation continuation policy

Rel.AI keeps one current model-facing tool surface. Operations that fit the safe response window return directly; longer eligible operations continue through the principal- and workspace-scoped background fallback and preserve `work_id` when one was supplied. Completion is persisted. When the same principal/workspace has an exact active MCP Events subscription whose filters match the terminal event, the webhook can deliver that event; otherwise the one-time `completedOperations` fallback remains available on a later Rel.AI call. Agents should continue useful independent work instead of polling. Work-session status remains the explicit retrieval path when the result itself is needed. There are no legacy tool aliases, compatibility operation names, or client-name heuristics.

Transport connections deliver requests but do not retain work-session identity. They never select, merge, replay, or complete repository work.

## Secure MCP Tunnel boundary

OpenAI Secure MCP Tunnel is transport, not an alternate MCP implementation. The same canonical local server may be associated with supported OpenAI surfaces such as ChatGPT, Codex, or the Responses API; product identity does not create another Rel.AI protocol implementation.

1. ChatGPT sends MCP traffic through the configured OpenAI tunnel.
2. The bundled `tunnel-client` forwards the `main` channel to the private local Rel.AI `/mcp` service.
3. Tunnel-client injects the private Rel.AI bearer header for that local hop.
4. The normal MCP authorization, request validation, tool policy, task ownership, and workspace boundaries execute locally.
5. Results return through the same tunnel transport.

The tunnel ID, tunnel-client process, ChatGPT conversation, Rel.AI `work_id`, fallback `operationId`, and managed-process `processId` remain independent identifiers.

A transport reconnect may restore connectivity but may not replay an ambiguous mutation. The local task-integrity model remains authoritative about mutation ownership and completion evidence.

Agents API sessions use the same canonical MCP behavior when their execution environment can reach or launch Rel.AI. Environment-origin HTTP and stdio are compatible local/private deployment models. A service-origin connection is not a substitute for Secure MCP Tunnel and must not be pointed at the loopback-only Rel.AI listener.

## Unsupported compatibility surfaces

- Initialize-based lifecycle handling on stdio.
- Sessionful legacy HTTP operation or `MCP-Session-Id`.
- Legacy `/sse` and `/messages` routes.
- Removed local OAuth routes `/register`, `/authorize`, and `/token`.
- JSON-RPC request batches.
- Removed tool aliases.
- Transport- or conversation-derived repository work identity.
- Legacy `2025-11-25` tool, resource, prompt, or task operations; the retained compatibility surface is startup lifecycle only.
- Responses to JSON-RPC notifications.

Unsupported protocol versions and modern-envelope mismatches fail closed. The HTTP compatibility path serves only `2025-11-25` `initialize` and `notifications/initialized` directly through the SDK rather than rewriting them into a `2026-07-28` envelope. Every other MCP method requires the modern request model.

## Version changes

A future MCP or public schema upgrade must update the implementation, release metadata, tests, package acceptance, documentation, and changelog together. Rel.AI does not advertise speculative protocol dates or custom replacements for MCP lifecycle behavior.
