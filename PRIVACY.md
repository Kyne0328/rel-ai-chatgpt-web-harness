# Rel.AI MCP Privacy Policy

**Effective date: September 28, 2026**

This Privacy Policy explains how Rel.AI MCP ("Rel.AI") handles information when you use the Rel.AI desktop application, local MCP runtime, repository tools, browser/computer capabilities, update surfaces, and related project resources maintained by Kyne ("the maintainer").

Rel.AI is designed as a local-first development harness for ChatGPT. The repository and runtime remain on your computer, but information that a task needs can be returned to ChatGPT through the connection you configure. This policy describes that boundary explicitly.

## 1. Information Rel.AI processes locally

Depending on the features you use, Rel.AI can process information such as:

- project files, file metadata, diffs, repository structure, Git state, and configured remotes;
- commands, command output, validation results, managed-process state, and task activity;
- workspace aliases and configuration;
- task/session history, saved local context, memory/learning state, and validation evidence;
- local analytics counters and timing information;
- troubleshooting logs, update state, indexes, caches, and temporary command-output files;
- browser session state when you use Rel.AI browser capabilities, including a persistent local browser profile when that mode is selected;
- screenshots, clipboard text, application information, and pointer/keyboard actions when you explicitly enable or request computer-control features; and
- application preferences and desktop lifecycle state.

Rel.AI does not require a hosted copy of your repository in order to operate.

## 2. Information sent through your ChatGPT connection

When ChatGPT requests a Rel.AI tool action, Rel.AI returns bounded tool inputs and results needed for that request. Depending on the action, those results can include file excerpts, diffs, repository metadata, command arguments or output, validation results, process information, screenshots, browser content, selected local files, workspace aliases, task identifiers, or other local information relevant to the task.

The supported ChatGPT connection uses OpenAI Secure MCP Tunnel. Information sent to ChatGPT or other OpenAI services is handled by OpenAI under the terms, privacy settings, and data controls that apply to your OpenAI account or workspace. The Rel.AI maintainer does not control OpenAI's independent retention, training, or account policies.

Rel.AI does not upload your entire repository merely because a workspace is configured. Data is transferred when a requested capability needs to return it to ChatGPT or another service you explicitly use.

## 3. Credentials and sensitive configuration

The Rel.AI desktop app stores the OpenAI tunnel runtime API key using Electron `safeStorage` when the operating system supports it. The normal renderer receives only whether a runtime key is configured, not the stored key itself.

Rel.AI also uses a private local bearer credential for the loopback MCP service. That credential is intended to remain on the computer running Rel.AI.

You are responsible for protecting repository credentials, tunnel credentials, private keys, access tokens, and other secrets. Do not place secrets in public issues, screenshots, or diagnostic exports.

## 4. Local analytics

Rel.AI records aggregate local analytics for product activity such as action counts, outcomes, reliability categories, timing, tools, and project/workspace aggregates. Current local analytics are retained for approximately **180 days** and are pruned automatically.

Local analytics do **not** store prompts, file paths, file contents, command output, action results, or raw error details.

You can clear local analytics from the Analytics page without deleting project files, task history, memory, settings, or telemetry configuration.

## 5. External usage measurement and diagnostic telemetry

Official Rel.AI release builds send a minimal installation-presence request to the maintainer's usage endpoint. This usage measurement is always enabled in an official build that has that endpoint configured and does not have a separate off switch. It is used to count unique and active Rel.AI installations without treating every normal reinstall as a new installation.

The presence payload contains only a schema version, a random pseudonymous installation ID, Rel.AI version, operating-system platform, and CPU architecture. The service records the receipt time. Rel.AI also creates a random installation-scoped ingest credential locally; only its one-way hash is stored by the telemetry service, and the credential is used to authenticate later presence and diagnostic uploads. A successful presence request records its local report time and is normally refreshed about every 12 hours. Normal reinstalls reuse the ID and ingest credential while that local state is retained. Clearing all Rel.AI local data, changing operating-system users, or otherwise removing that identity can cause a later installation to receive a new ID. Rel.AI does not derive this ID or credential from a hardware serial number, device fingerprint, or operating-system account identifier.

The maintainer usage service stores one installation row keyed by that pseudonymous ID, with first-seen and last-seen times, first and current Rel.AI versions, platform, architecture, and the one-way ingest-credential hash. Raw installation rows are retained for up to 400 days after their last presence. Small daily aggregate trend rows are retained for up to 730 days. The presence schema rejects unexpected client fields instead of adding them to this registry.

Diagnostic OpenTelemetry tracing is **on by default** but can be turned off in Settings. Diagnostic traces can include tool names, project aliases, durable task identifiers, client/runtime information, timings, and complete command text for executed commands and validation checks. Rel.AI redacts common credential patterns in command text, including tokens, passwords, API keys, authorization values, cookies, private keys, credential environment assignments, and URL passwords, before export. Complete commands are user-controlled text and can still contain project paths, inline code, SQL, literal arguments, or secret formats that do not match the redaction rules, so secrets should not be placed directly in command lines. Rel.AI does not add prompts, file contents, command output, or raw exception messages as diagnostic telemetry fields. Official builds authenticate diagnostic uploads with the installation-scoped ingest credential and send them through the maintainer's Cloudflare telemetry edge to the configured diagnostic storage service; disabling diagnostic telemetry stops that trace export without disabling minimal installation presence.

Cloudflare processes requests to the maintainer telemetry endpoint and can process normal network metadata to deliver and protect that service. The Rel.AI Worker does not add network-address metadata to D1 installation records or forwarded diagnostic trace attributes. The maintainer's diagnostic-retention target is 30 days; the production Axiom dataset must be configured separately to enforce that provider-side limit. Advanced or development configurations can direct diagnostic traces to another OTLP endpoint; the operator of that external endpoint controls its own storage, retention, security, and deletion practices.

## 6. Local retention and deletion

Most Rel.AI-owned state remains on your computer until it is cleared, replaced, expired by a feature-specific retention rule, or removed by you. The desktop app provides controls for clearing local analytics, task/activity history, troubleshooting logs, temporary output, and other local data.

Completed, failed, and cancelled task/activity history uses a 180-day local retention target with a 1 GiB task-history storage budget. When the storage budget is exceeded, Rel.AI removes the oldest terminal task history first. Open or resumable task records are not removed by that terminal-history pruning rule. The Tasks and Activity screens load retained history in pages, so their initial visible rows are not the storage-retention limit.

Logging out can remove the saved OpenAI tunnel connection and, if you choose **Clear all local data**, delete Rel.AI-owned local application data while leaving your configured project folders and project files intact.

Rel.AI's desktop uninstall configuration can preserve application data. If you want Rel.AI-owned local data erased, use the in-app clear/logout controls before uninstalling.

Derived repository indexes and caches can be rebuilt from local project source and may be removed independently from project files.

## 7. Third-party services

Rel.AI can interact with third-party services that have their own terms and privacy practices, including:

- **OpenAI / ChatGPT / Secure MCP Tunnel** for the ChatGPT connection you configure;
- **GitHub** for source code, release discovery, downloads, issues, and release artifacts;
- **Cloudflare and Axiom** for the official usage-measurement and optional diagnostic-telemetry services described above; and
- operating-system or browser services that you explicitly invoke through Rel.AI.

Using those services can cause information to be processed by those providers independently of Rel.AI.

## 8. Security

Rel.AI uses workspace containment, bounded data movement, credential separation, renderer isolation, scoped Git publishing, update verification, and other controls described in the project's security documentation. Rel.AI is still a trusted local development harness, not a sandbox. Repository scripts and enabled desktop actions execute with the permissions available to the Rel.AI process.

See [SECURITY.md](SECURITY.md) and [docs/SECURITY.md](docs/SECURITY.md) for reporting and technical security details.

## 9. Changes to this policy

This policy can change when Rel.AI's data flows or product features change. Material changes should be reflected in the repository and release documentation. The effective date at the top identifies the current policy version.

## 10. Contact

For privacy questions, use the project repository at <https://github.com/Kyne0328/rel-ai-chatgpt-web-harness> and avoid including secrets or private repository content in public issues.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of publishing vulnerability details in a normal issue.
