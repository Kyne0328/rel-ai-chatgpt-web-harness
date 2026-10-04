# Rel.AI MCP One-Click Setup

This guide covers the packaged desktop application. Rel.AI connects ChatGPT web to local projects through one supported transport: **OpenAI Secure MCP Tunnel**. One desktop can supervise multiple independent tunnels for different ChatGPT accounts while keeping one local MCP service, one workspace configuration, and one task history. ChatGPT provides the conversation and reasoning; project files and commands stay on the computer running Rel.AI.

## Before you begin

You need:

- the Rel.AI MCP desktop application for Windows, macOS, or Linux;
- an OpenAI Secure MCP Tunnel created for this computer;
- a runtime API key for that tunnel;
- a ChatGPT plan/workspace that can use the required MCP integration; and
- at least one local repository folder you are willing to configure as a Rel.AI workspace.

## Install and first run

1. Install or launch the appropriate Rel.AI MCP desktop package.
2. In the setup wizard, enter the OpenAI **Tunnel ID** and **runtime API key** for this computer.
3. Keep the default local connection port unless it conflicts with another local application.
4. Choose **Start secure connection**. Rel.AI starts its private local MCP service and the bundled OpenAI tunnel client.
5. Open **Workspaces**, add a repository folder, and give it a short alias such as `myapp`.
6. In ChatGPT, create or reconnect the Rel.AI MCP integration using the **Tunnel** connection option and associate it with this computer's tunnel.
7. Enable Rel.AI MCP in the chat and send a read-only first request.

The runtime API key is encrypted through Electron `safeStorage` and is write-only after it is saved. Rel.AI does not require a second public transport account or a public URL entered by the user.

## Add another ChatGPT account

Each additional ChatGPT account should create its own Secure MCP Tunnel and runtime API key in the OpenAI Platform context that account can use. Then open **Settings → Connection → Additional ChatGPT tunnels** in Rel.AI and add that Tunnel ID and runtime key.

Rel.AI starts another bundled tunnel-client for that Tunnel ID, but it does not start another MCP server or duplicate your workspaces. The primary tunnel and all additional tunnels forward to the same private local `/mcp` endpoint. Removing an additional tunnel stops only that tunnel connection.

## What stays local

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> bundled tunnel-client
  -> private local Rel.AI MCP service
  -> configured local workspace
```

Repository files, full workspace paths, commands, Git operations, tests, builds, managed processes, workspace configuration, task history, and local analytics stay on this computer. The tunnel is the private connection between ChatGPT and Rel.AI; it does not own your project or decide what happens to a work session.

## Add your first workspace

1. Open **Workspaces**.
2. Choose **Add workspace**.
3. Select a project folder.
4. Enter or accept a short workspace alias.
5. Review repository and validation information.
6. Save the workspace.

Use a read-only first request before allowing edits:

```text
Use Rel.AI MCP with workspace "myapp". Start one work session, read the project, and explain how the relevant parts work before changing anything.
```

## Connection and Usage

**Connection** shows the configured tunnel ID, whether the runtime key is stored, local MCP health, Secure MCP Tunnel health, and recovery actions. Saving connection settings restarts only the Rel.AI connection service and tunnel client; it does not restart unrelated developer processes.

**Usage** is built from locally observed Rel.AI activity. It is not ChatGPT model-token or billing accounting.

Rel.AI uses the normal ChatGPT app/tool path rather than Codex. OpenAI documents that ChatGPT Apps use the normal limits for your plan while Codex usage counts toward agentic usage, so Rel.AI does not draw from the Codex agentic allowance. Your normal ChatGPT plan limits still apply. See [Connecting to ChatGPT](CONNECTING_TO_CHATGPT.md) for the current usage and compatibility notes.

## Application updates

Installed Windows builds check for updates periodically. Update discovery, download, and restart-to-install remain explicit user actions, and restart-to-install is blocked while Rel.AI work is active. Application update state is independent from tunnel connectivity and repository task completion.

## Troubleshooting

If the tunnel does not connect:

1. confirm the Tunnel ID starts with `tunnel_` and belongs to the intended OpenAI Secure MCP Tunnel;
2. replace the runtime API key in **Connection** if the saved key was revoked or replaced;
3. confirm the configured local port is available;
4. keep Rel.AI running while ChatGPT reconnects to the tunnel; and
5. open **Diagnostics** for the sanitized local service and tunnel logs.

Diagnostic exports redact bearer credentials, API keys, passwords, authorization headers, and similarly named secret fields. Do not post tunnel runtime keys or repository credentials in public issues.
