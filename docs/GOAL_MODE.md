# ChatGPT Web Goal Mode (protocol-only)

Goal Mode is an opt-in monitor for an existing Rel.AI work session. It does not create another planning agent or use browser extensions. ChatGPT remains responsible for the task; Rel.AI observes factual work receipts and the conversation's current message branch.

## Installation and activation

Rel.AI ships `/goal` instructions inside the built-in `skills/rel-ai-workflow/SKILL.md`. No separate skill installation or new MCP tool is needed. Update/reconnect Rel.AI so ChatGPT can discover the revised skill and `relai_work` schema.

Use `/goal` (to mark the current task) or `/goal <objective>` in a normal ChatGPT conversation. The built-in workflow skill instructs ChatGPT to call `relai_work` with `action:"begin"`, the normal work plan, and `goal:true`. The returned `work_id` is also the Goal Mode identity. `goal` is false by default.

For bare `/goal`, ChatGPT must infer the objective from an already-established task rather than invent one. `relai_work begin` also accepts an optional `conversationUrl` with a `https://chatgpt.com/c/<conversation-id>` URL when `goal:true`. Without a URL, Rel.AI scans up to 20 recent conversations and attaches **only** if exactly one recent user message starts with `/goal` and its objective matches. Ambiguous or missing matches remain in `linking` state; never guess.

## Local authentication

In the Rel.AI desktop app, open **Browser → ChatGPT · Goal Mode → Sign in to ChatGPT**. Finish login, MFA, or verification directly in the embedded Chromium page, then select **Check sign-in**. Use **Sign out** to clear this Goal Mode account's dedicated saved browser data. Goal Mode uses a persistent profile under the app's user-data directory that is separate from normal browser automation sessions. Sign-in credentials are not exposed to MCP tool outputs, task logs, or the dashboard.

The local service sends only allowlisted ChatGPT protocol paths through the Electron main process, which attaches authentication within the dedicated browser session. The older `REL_AI_CHATGPT_WEB_BEARER` and `REL_AI_CHATGPT_WEB_COOKIE` environment variables remain optional for non-desktop development; they are not needed for the desktop sign-in flow. Do not paste credentials into chats or commit them to the repository.

The integration uses ChatGPT Web's internal undocumented protocol and does not attempt to bypass interactive verification. Unsupported auth challenges, missing conversation permissions, model limits, or protocol changes can pause Goal Mode. This setup requires a separately established authenticated session; it does **not** take credentials automatically from your ordinary browser.

## Monitoring and control

The desktop service checks active goals every 30 seconds and requires a stable, completed assistant message plus no active Rel.AI calls, approval wait, or blocked task before considering continuation. It rereads the conversation just before sending. The exact prior node is recorded transactionally **before** the HTTP send. If the result is uncertain, a retry cannot duplicate the same turn automatically.

Continuation uses `POST /backend-api/f/conversation` with conversation and parent message IDs. Probes use `GET /backend-api/conversation/{id}` and `GET /backend-api/conversations`. Stream events are consumed without storing full text. If ChatGPT requires a sentinel challenge Rel.AI cannot complete, the goal pauses rather than trying to circumvent it.

A goal also pauses if the previous continuation produces no new Rel.AI task activity, or after eight continuations. These bounds prevent endless self-replies. Explicit `relai_work finish`, task failure, or cancellation ends the goal.

In the Rel.AI desktop Tasks inspector, select a Goal Mode task and use **Stop Goal** to disable further automatic sends without cancelling the work session or its processes. The button is shown only for active goals. ChatGPT can also call `relai_work` with `action:"goal_status"` to inspect the exact work ID, or `action:"goal_stop"` to disable monitoring. A network request already accepted by ChatGPT may complete after the user stops the goal; it cannot be withdrawn retroactively. Stopping the task itself remains the separate `relai_work cancel` operation.

## Limitations

- The desktop Tasks inspector has a **Stop Goal** button. It controls the same persisted goal record as `relai_work goal_stop`; there is no separate MCP tool.
- Changes to ChatGPT's private endpoints, SSE framing, session refresh, and challenge flow are outside Rel.AI's compatibility contract.
- Live continuation in an existing normal ChatGPT Web tab has **not** been verified against a real signed-in session. Browser tab synchronization and MCP tool availability on externally submitted turns remain unproven.
- Desktop Goal Mode requires a signed-in, locally authenticated ChatGPT session and a uniquely linked conversation. Check sign-in does not establish protocol compatibility; HTTP requests can still fail as endpoints change.
- The authenticated protocol bridge and session isolation have automated fixture coverage, but live same-thread continuation and MCP re-entry still require an authenticated end-to-end test before production readiness can be asserted.
