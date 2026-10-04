# OpenAI client compatibility

Rel.AI exposes one canonical MCP runtime and one canonical public tool surface. Compatibility is negotiated from MCP protocol and capability metadata. Rel.AI does not switch behavior based on a client product name.

## ChatGPT

The primary desktop setup remains ChatGPT through OpenAI Secure MCP Tunnel. The tunnel forwards authenticated MCP traffic to the private loopback Rel.AI service; local authorization, work ownership, Git safety, browser/computer policy, and validation remain authoritative on the Rel.AI machine.

Rel.AI intentionally does not expose an MCP Apps task panel or app-only helper tools. ChatGPT receives the same canonical coding tools as other supported clients, while the Rel.AI desktop application remains the human-facing surface for task state, processes, output, permissions, diagnostics, and local control.

## Codex and Responses API

OpenAI Secure MCP Tunnel is the supported private-MCP transport for OpenAI products that can associate with an existing tunnel. Rel.AI does not add a Codex-specific or Responses-specific server implementation.

The compatibility contract is:

1. the client negotiates current MCP;
2. the same canonical `tools/list` surface is returned;
3. authorization and principal construction use the normal transport boundary;
4. client implementation names do not select compatibility code paths;
5. long-running work uses Rel.AI's principal- and workspace-scoped background fallback rather than product-specific task routing.

A tunnel association is transport configuration. It does not change repository ownership, replay rules, or completion authority.

## Agents API

Agents API MCP connections have a different deployment choice from the desktop Secure MCP Tunnel flow.

Use an environment-origin MCP connection when the Agents API session environment can reach the Rel.AI HTTP endpoint, for example when a self-hosted session environment runs on the same trusted machine or network as Rel.AI. In that model, the environment connects to Rel.AI directly and the normal Rel.AI bearer, host/origin, workspace, and task policies still apply.

Use stdio only when the agent session environment is intended to launch Rel.AI itself. Stdio remains modern-only and does not restore the legacy HTTP startup lifecycle.

Do not configure the Agents API service origin against Rel.AI's loopback/private URL. A service-origin connection requires an MCP endpoint reachable by OpenAI's service, which is intentionally not what the local Rel.AI HTTP listener provides.

Rel.AI does not move local task ownership or filesystem/Git authority into the Agents API. The agent is a client of the local MCP runtime.

## MCP Events

Rel.AI advertises `events: {}` on modern authenticated HTTP and implements `events/list`, `events/subscribe`, and `events/unsubscribe` for webhook delivery. Subscriptions are bound to the authenticated principal, may filter by workspace/work/process identity, require verified public HTTPS callbacks, persist encrypted signing secrets, and use Standard Webhooks signatures. Rel.AI currently publishes terminal durable-work, long-running-operation, and managed-process events.

When an exact operation event subscription is active, that webhook replaces the corresponding `completedOperations` piggyback notification. Without a matching Events subscription, the existing one-time completion fallback remains for compatibility. `taskProgress` is unaffected because it carries model-to-Rel.AI plan updates rather than Rel.AI-to-client notifications.

## Compatibility tests

The HTTP smoke suite exercises ChatGPT, Codex, Responses API, and Agents API client implementation names against the same server. All must negotiate the same current protocol and receive the same canonical tool surface.

Separate tests cover:

- real MCP Events discovery, callback safety, signing, exact subscription matching, and completion fallback behavior;
- the canonical coding surface with no app-only tools or `ui://relai/*` resources;
- the existing ChatGPT startup compatibility shim;
- principal- and workspace-scoped background fallback behavior for long-running work.

Client-product names are test labels only. They are not production routing inputs.
