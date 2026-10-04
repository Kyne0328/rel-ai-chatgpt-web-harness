# Connecting the Rel.AI harness to ChatGPT

Rel.AI is a local harness for ChatGPT Web connected through **OpenAI Secure MCP Tunnel**. ChatGPT remains the model, conversation, and reasoning host. Rel.AI supplies the local agency/runtime layer: repository access, work sessions, commands and processes, validation, Git, skills/memory, observability, and explicitly enabled computer control on the machine running Rel.AI.

## Configure the tunnel

1. Create an OpenAI Secure MCP Tunnel for this computer and create a runtime API key for it in OpenAI Platform.
2. Open Rel.AI MCP and enter the **Tunnel ID** and **runtime API key** in the first-run wizard or **Connection** page.
3. Keep Rel.AI running until Connection reports the Secure MCP Tunnel as **Connected**.
4. Follow the highlighted ChatGPT connector guide on **Overview**, then add at least one local workspace before asking ChatGPT to inspect repository files.

Rel.AI encrypts saved runtime API keys with Electron `safeStorage`. Keys are never returned to the renderer after storage.

### Connect multiple ChatGPT accounts

Keep the first tunnel as the primary connection. For every additional ChatGPT account:

1. sign in to that account's OpenAI Platform context and create its own Secure MCP Tunnel and runtime API key;
2. in Rel.AI, open **Settings → Connection → Additional ChatGPT tunnels** and add that Tunnel ID and runtime API key;
3. in that ChatGPT account, create or reconnect **Rel.AI MCP** with **Connection: Tunnel**, select that account's tunnel, and use **Authentication: No authentication**.

Rel.AI runs one tunnel-client process per configured Tunnel ID. All of those processes forward to the same private local `/mcp` service, so the accounts see the same Rel.AI workspaces and local task system. A failed additional tunnel does not replace the primary tunnel or require another Rel.AI installation.

## Connect ChatGPT

After the Secure MCP Tunnel connects, Rel.AI opens **Overview** and highlights the remaining ChatGPT setup so you can continue from the same getting-started guide. Save the provided `relai-mcp.png` icon if you want to use it, then use **Open ChatGPT plugin setup** to open `https://chatgpt.com/plugins#settings/Connectors?create-connector=true`.

Create the connector with **Name: Rel.AI MCP**, **Connection: Tunnel**, the same Tunnel ID shown in Rel.AI, and **Authentication: No authentication**. Click **Scan Tools**, confirm the Rel.AI tools appear, then click **Create**. After creation, open **Manage** and upload the saved Rel.AI icon as the connector logo.

If the integration already exists, reconnect or refresh it rather than creating a second copy unless you deliberately want a separate tunnel association.

After enabling Rel.AI MCP in a chat, start with a read-only request:

```text
Use Rel.AI MCP with workspace "myapp". Start one work session, read the project, and explain how the relevant parts work before changing anything.
```

For each meaningful durable project goal that ChatGPT handles through Rel.AI, it should start or reuse one work session and keep its `work_id` across the goal. Every new durable task starts with a non-empty `steps` plan on `relai_work begin`, and ChatGPT keeps that plan current as evidence changes. Projectless one-shot utility or control work should use an already-supported taskless operation without creating a durable task or inventing a workspace. Taskless calls also remain available for isolated control, recovery, observation, and resource operations.

## Why Rel.AI uses ChatGPT

Rel.AI uses ChatGPT's app/tool path, not Codex. OpenAI currently documents that [Apps use the normal ChatGPT rate limits for your plan](https://help.openai.com/en/articles/11487775-connectors-in), while [Codex usage counts toward agentic usage](https://help.openai.com/en/articles/11369540-codex-and-chatgpt-plan-usage-limits). Rel.AI therefore does not draw from the Codex agentic allowance. Your normal ChatGPT plan limits still apply, so Rel.AI does not describe its usage as unlimited.

ChatGPT supplies the model, conversation, and reasoning. Rel.AI supplies the durable local harness around that model. MCP carries the tool calls, but local task state, validation evidence, process ownership, Git state, memory/skills, and desktop control remain Rel.AI responsibilities. Model availability and plan limits are controlled by ChatGPT and may change independently of Rel.AI.

For many everyday repository tasks, Rel.AI can take the place of a Codex-style workflow: it can help ChatGPT read the project, edit files, run commands and tests, inspect the result, and use Git. Rel.AI does not emulate Codex internals or claim to be the same product.

## Why other AI clients are not supported

Rel.AI does not currently support Claude, Cursor, Gemini, or other AI clients. The desktop app, Secure MCP Tunnel connection, work-session model, workspace permissions, checks, recovery, and publishing rules are designed and tested around ChatGPT. Supporting another client would require its own connection and compatibility contract.

## Local connection security

The ChatGPT-facing MCP service inside the Rel.AI harness requires a bearer credential. The bundled tunnel client adds that credential when it forwards MCP traffic to Rel.AI. ChatGPT does not receive or need the local Rel.AI bearer token.

The public Rel.AI runtime no longer exposes a local OAuth authorization server. `/register`, `/authorize`, `/token`, legacy `/sse`, and legacy `/messages` are not supported connection paths.

## MCP protocol requirement

Modern MCP behavior targets `2026-07-28`. HTTP retains only the SDK-supported stateless ChatGPT `2025-11-25` startup lifecycle (`initialize` and `notifications/initialized`); all ordinary tool, resource, prompt, and Events requests use `2026-07-28`. Rel.AI does not issue `MCP-Session-Id`; JSON-RPC batches, removed tool aliases, and initialize-based stdio are not supported.

Short bounded operations complete directly. Longer eligible operations can return a running result and continue safely in Rel.AI's background fallback under the same authorized principal/workspace and, when present, the same `work_id`. Continue independent work instead of polling while useful work remains: a later Rel.AI call can receive newly finished background work once under `completedOperations`, while matching MCP Events subscriptions can receive completion webhook events. Use `relai_work` with `action:"status"` when the result is actually needed or no other useful independent work remains.

## Reconnects and tool changes

A tunnel reconnect restores the connection only. It does not choose a workspace, pick a work session, repeat an uncertain edit, or mark repository work complete.

When the public tool schema changes, ChatGPT must review the updated action snapshot before it can reliably use the new Rel.AI surface. For **Go/Plus/Pro**, open **Plugins → +**, select **Rel.AI MCP**, and follow ChatGPT’s connector update prompt. For **Enterprise/Edu**, open **Workspace settings → Apps**, find **Rel.AI MCP**, open its menu, choose **Action control**, then click **Refresh** and review the changed actions before publishing or applying the update. For **Business**, published custom apps currently cannot update tools or metadata in place; recreate and republish the app when the Rel.AI tool surface changes. Application updates, tunnel connectivity, and host-side action refresh are separate states.

## Troubleshooting

If ChatGPT cannot reach Rel.AI:

- confirm Rel.AI shows the Secure MCP Tunnel as Connected;
- confirm ChatGPT is associated with the same Tunnel ID shown in Rel.AI;
- replace the tunnel runtime API key in **Connection** if it was revoked;
- confirm the local connection port is available; and
- open **Diagnostics** for sanitized tunnel and local-service logs.

If a workspace cannot be found, confirm its alias under **Workspaces**, then retry a simple read-only request in ChatGPT. Opening `/mcp` in a normal browser is not a connection test; MCP clients use `POST /mcp`.
