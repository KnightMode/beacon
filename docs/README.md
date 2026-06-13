# Beacon documentation

The [README](../README.md) is the pitch. This is everything else.

| Doc | What's inside |
|---|---|
| [Architecture](./architecture.md) | How a question becomes a cited answer: workers, indexer, retrieval, the code graph, the stack. |
| [Setup](./setup.md) | End-to-end install: Cloudflare resources, GitHub PAT + App, Slack app, secrets, deploy. |
| [Usage](./usage.md) | Every Slack command, how to index repos, and how to trigger indexing manually. |
| [Security model](./security.md) | Signature verification, prompt-injection posture, secret redaction, and the auth boundary. |
| [Site Access](./site-access.md) | Protect the Cloudflare Pages admin portal with email OTP login via Cloudflare Access. |
| [Development](./development.md) | Local workflow, tests, dry-runs, and the answer-quality eval harness. |
| [Roadmap](./roadmap.md) | What's shipped and the highest-leverage next steps. |

New here? Read [Architecture](./architecture.md), then follow [Setup](./setup.md).
