# Admin portal

The admin portal is live inside the existing Cloudflare Pages site. It is not a
separate React app or a separate Worker.

## Current implementation

```
site/
  admin/                 static admin UI
  admin/onboarding/      guided onboarding page

functions/
  api/admin/*            session, onboarding summary, repos, channel mapping
  api/admin/slack/*      Slack OAuth start + channel list
  api/admin/github/*     GitHub App start, callback completion, repo picker
  oauth/slack/callback   Slack OAuth callback
  oauth/github/callback  GitHub App setup callback
```

The portal serves two views:

- `/admin/` — workspace status: Slack/GitHub connection state, selected repos,
  and onboarding progress.
- `/admin/onboarding/` — guided six-step setup: connect Slack, connect GitHub,
  choose repos, watch indexing, map a CI notification channel, and ask the first
  cited question.

## Identity and session model

Slack OAuth is the first step. The callback creates or updates a tenant keyed by
Slack workspace/team ID, stores the Slack bot token encrypted with
`SLACK_TOKEN_ENCRYPTION_SECRET`, records the Slack install, and sets a signed
`beacon_admin_session` cookie.

GitHub App setup is linked to that Slack tenant by a short-lived signed
`beacon_github_link` cookie plus the optional GitHub setup `state` value.
Repository listing uses GitHub App installation access through Octokit App auth,
so the picker only shows repositories visible to the installation.

## Data written by the portal

The current implementation uses the shared `scintel` D1 database with
tenant-scoped rows:

- `tenants`
- `tenant_slack_installs`
- `tenant_github_installations`
- `pending_installation_repos`
- `tenant_repos`
- `tenant_onboarding_steps`
- `tenant_ci_notify_channels`
- `repos`
- `repo_index_status`

Selecting repositories writes `tenant_repos` rows and, when
`PIPELINE_DISPATCH_*` is configured, fires the GitHub Actions indexing workflow
through `repository_dispatch`. Index status is read from `repo_index_status`;
the portal also syncs remote D1 index status when the relevant Cloudflare API
vars are present.

## Security boundary

In deployed environments, Cloudflare Access protects `/admin`, `/api/admin`,
`/oauth/slack/callback`, and `/oauth/github/callback`. Pages middleware verifies
the Access JWT issuer, audience, expiry, signature, and optional email/domain
allow-list before serving the admin UI or API routes.

Localhost is exempt by default so `wrangler pages dev` remains usable.

## Local verification

```bash
cp site/.dev.vars.example .dev.vars
npm run db:local:init
npm run dev:portal
```

Then in another terminal:

```bash
npm run verify:local
```

Mock OAuth is available for local smoke tests:

- `/api/admin/slack/start?mock=1`
- `/api/admin/github/start?mock=1`

## Not implemented yet

The broader customer dashboard is still future work. The current portal does
not include billing, usage charts, people/roles, audit-log browsing, account
deletion, or Stripe Customer Portal links. Those belong to the future SaaS plan
in [multi-tenant-saas.md](multi-tenant-saas.md), not to the current runtime.
