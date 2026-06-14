# Beacon documentation

The [README](../README.md) is the pitch. This is everything else.

| Doc | What's inside |
|---|---|
| [Architecture](./architecture.md) | How a question becomes a cited answer: workers, indexer, retrieval, the code graph, the stack. |
| [Setup](./setup.md) | End-to-end install: Cloudflare resources, GitHub PAT + App, Slack app, secrets, deploy. |
| [Usage](./usage.md) | Every Slack command, how to index repos, and how to trigger indexing manually. |
| [Security model](./security.md) | Signature verification, prompt-injection posture, secret redaction, and the auth boundary. |
| [Admin portal](./admin-portal.md) | Current Pages admin onboarding flow: Slack OAuth, GitHub App, repo picker, indexing status, and setup state. |
| [Onboarding](./onboarding.md) | Customer setup flow as implemented today, plus what remains future work. |
| [Local verification](./local-verification.md) | Local D1 + mock OAuth smoke tests for the Pages admin portal and tenant-scoped bot behavior. |
| [Site Access](./site-access.md) | Protect the Cloudflare Pages admin portal with email OTP login via Cloudflare Access. |
| [Cloudflare Terraform](./cloudflare-terraform.md) | Terraform ownership for stable Cloudflare resources and the remaining Wrangler/runtime split. |
| [Development](./development.md) | Local workflow, tests, dry-runs, and the answer-quality eval harness. |
| [Multi-tenant SaaS plan](./multi-tenant-saas.md) | Current shared-D1 tenant scope and the remaining path to fully isolated, billable SaaS. |
| [Provisioning design](./provisioning.md) | Future per-tenant D1/Vectorize provisioning design; not the current runtime model. |
| [RBAC design](./rbac.md) | Future role and per-user repo permission model. |
| [Roadmap](./roadmap.md) | What's shipped and the highest-leverage next steps. |

New here? Read [Architecture](./architecture.md), then follow [Setup](./setup.md).
