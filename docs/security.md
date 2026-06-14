# Security model

- **Signature verification** — Slack and GitHub signatures are verified on
  every request.
- **Prompt-injection resistance** — retrieved code is treated strictly as
  untrusted data in prompts, never as instructions.
- **Secret redaction** — chunks with obvious credentials are redacted before
  embedding.
- **Admin portal Access** — deployed `/admin`, `/api/admin`, and OAuth callback
  routes require a valid Cloudflare Access JWT. The Pages middleware verifies
  the `Cf-Access-Jwt-Assertion` signature, issuer, audience, expiry, and optional
  email/domain allow-list before serving admin UI or API routes. Localhost is
  exempt by default so `wrangler pages dev` remains usable.

## Tenant auth

Multi-tenant onboarding stores Slack installs, GitHub App installations,
installation repo grants, selected GitHub repos, and optional notification
channels per tenant. Slack bot retrieval is restricted to repos selected for the
requesting Slack team.

Tenant GitHub access uses short-lived GitHub App installation tokens resolved
from the selected repo's installation. Legacy PAT paths are for local/internal
prototype traffic only and must not be used when a Slack `team_id` is present.

User-level GitHub permissions are not enforced yet. The extension points for
per-user access control are already in place:

- the `users` and `github_user_repo_permissions` tables, and
- the per-repo retrieval filter.

Wiring per-user GitHub OAuth into these gives you permission-aware retrieval
where each Slack user only sees the repos they can actually access.
