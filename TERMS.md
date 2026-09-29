# Rel.AI MCP Terms of Use

**Effective date: September 28, 2026**

These Terms of Use ("Terms") describe the terms that apply when you use official Rel.AI MCP application distributions, project websites, release/update channels, documentation, support surfaces, or other services operated by the Rel.AI maintainer (collectively, the "Rel.AI Services").

The Rel.AI source code is open source under the Apache License, Version 2.0. These Terms do not reduce, replace, or restrict rights granted to you by that license. If these Terms conflict with the Apache License about copying, modifying, or distributing Apache-licensed code, the Apache License controls.

## 1. Rel.AI is a local development harness

Rel.AI connects ChatGPT to capabilities on a computer you control. Depending on the features you enable and the requests you make, Rel.AI can read or modify project files, execute commands, run tests or builds, manage processes, use Git, operate a local browser, and perform authorized desktop actions.

Those are real operations on your computer. Rel.AI is not a sandbox and does not guarantee that a command, repository, website, model response, dependency, or third-party tool is safe or correct.

## 2. Your responsibilities

You are responsible for:

- using Rel.AI only with computers, repositories, accounts, services, and data that you own or are authorized to access;
- reviewing commands, changes, Git operations, browser actions, and computer-control permissions appropriate to your environment;
- protecting credentials, secrets, private keys, runtime API keys, and repository access tokens;
- maintaining backups or source-control history appropriate for important work;
- complying with laws, contracts, software licenses, employer policies, and third-party terms that apply to your use; and
- deciding whether AI-generated or tool-generated output is suitable before relying on, publishing, or deploying it.

## 3. Open-source license and third-party software

Rel.AI's own source distribution is licensed under [Apache-2.0](LICENSE). The Apache license governs your rights to use, reproduce, modify, and distribute that code.

Rel.AI also includes or depends on third-party software governed by separate licenses. Those components remain subject to their respective license terms. See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Nothing in these Terms grants rights to third-party trademarks, services, models, or content beyond rights provided by their owners.

## 4. Third-party services

Rel.AI relies on or can interact with third-party services, including OpenAI services, GitHub, Cloudflare, and Axiom. Official builds use Cloudflare for the maintainer-operated telemetry edge and installation-count storage, and can use Axiom for optional diagnostic-trace storage. Your use of third-party services is subject to their applicable agreements and policies.

The maintainer does not control the availability, pricing, rate limits, model behavior, account eligibility, data handling, API behavior, or continued operation of third-party services. A change by a third party can affect Rel.AI functionality without a Rel.AI code change.

## 5. Privacy and local data

Rel.AI is local-first, but requested tool results can be sent through your configured ChatGPT connection when a task needs them. Local analytics, minimal external usage measurement, optional diagnostic telemetry, credential storage, retention, and deletion controls are described in the [Privacy Policy](PRIVACY.md).

By enabling a capability or external endpoint, you are responsible for understanding the data that capability can process or transmit.

## 6. Updates and compatibility

Official Rel.AI releases can include update discovery, verified downloads, and platform-specific installation behavior. You decide whether to install an update unless a future service explicitly states otherwise.

Older versions can stop being compatible with ChatGPT, MCP, OpenAI Secure MCP Tunnel, operating systems, browsers, dependencies, or other external systems. The maintainer may stop supporting older versions when maintaining them is no longer practical or safe.

## 7. AI and automation output

Rel.AI does not provide legal, financial, medical, security, compliance, or other professional advice. ChatGPT and other automated systems can produce incorrect, incomplete, outdated, or unsafe output.

A successful tool call, command exit code, test result, or model response does not guarantee that software is correct, secure, production-ready, or fit for a particular purpose. You remain responsible for review and deployment decisions.

## 8. Availability and changes

Rel.AI Services can change, be interrupted, or be discontinued. Features can be added, changed, or removed to address security, compatibility, maintenance, product, or legal requirements.

The maintainer does not promise uninterrupted availability, a particular response time, continued compatibility with every environment, or support for every repository or workflow.

## 9. Warranty and liability

The Apache License contains the warranty disclaimer and limitation of liability that apply to the Apache-licensed software. To the maximum extent permitted by applicable law, official Rel.AI Services are also provided without guarantees of uninterrupted availability, error-free operation, or fitness for a particular purpose unless the maintainer expressly agrees otherwise in writing.

Nothing in these Terms excludes or limits liability that cannot lawfully be excluded or limited.

## 10. Misuse of maintainer-operated services

If the maintainer operates a hosted website, update endpoint, support surface, or other service, access to that service may be limited or blocked when necessary to protect the service, other users, infrastructure, or legal obligations.

This section does not revoke or narrow rights you already have in Apache-licensed source code. Any termination of Apache-licensed rights is governed only by the Apache License itself.

## 11. Changes to these Terms

These Terms can be updated as Rel.AI Services change. Material changes should be published in the repository or release documentation. The effective date at the top identifies the current version.

Your continued use of maintainer-operated Rel.AI Services after updated Terms are published constitutes acceptance of those updated Terms to the extent permitted by applicable law. Your rights in previously received Apache-licensed code remain governed by the license applicable to that code.

## 12. Contact

Project and support information is available at <https://github.com/Kyne0328/rel-ai-chatgpt-web-harness>.

Do not publish credentials, private repository content, or vulnerability details in a public support request. Security reports should follow [SECURITY.md](SECURITY.md).
