# Onboarding flows

This document describes the onboarding flow implemented in the current repo.
The future SaaS expansion is tracked separately in
[multi-tenant-saas.md](multi-tenant-saas.md).

## Big picture

```
Connect Slack → connect GitHub App → choose repos → start indexing → map CI channel → ask first question
```

The flow lives in the existing Pages app at `/admin/onboarding/`. It is backed
by Cloudflare Pages Functions in `functions/` and the shared `scintel` D1
database.

## Step 1: Connect Slack

1. The user opens `/admin/onboarding/` and clicks **Connect Slack**.
2. `GET /api/admin/slack/start` redirects to Slack OAuth.
3. Slack redirects to `/oauth/slack/callback`.
4. The callback exchanges the code with Slack, creates or updates a tenant keyed
   by Slack team ID, stores the bot token encrypted with
   `SLACK_TOKEN_ENCRYPTION_SECRET`, records the Slack install, marks the
   `slack` onboarding step complete, and sets the signed admin session cookie.

If the same workspace reconnects, Beacon refreshes the install instead of
creating a duplicate tenant.

## Step 2: Connect GitHub App

1. The user clicks **Connect GitHub**.
2. `GET /api/admin/github/start` creates a short-lived GitHub link cookie and
   redirects to the configured GitHub App install URL.
3. GitHub redirects to `/oauth/github/callback` with an `installation_id`.
4. The callback validates the tenant linkage, records the installation, links
   any pending installation repositories, and marks the `github` step complete.

Repo listing in the admin portal uses short-lived GitHub App installation access
through Octokit App auth. The picker is therefore scoped to the repositories
approved during GitHub App installation.

## Step 3: Choose repositories

The repo picker calls `/api/admin/github/repos` to page/search repositories
visible to the tenant's GitHub App installation.

Submitting repos to `/api/admin/repos`:

- validates each repo against the tenant's installation,
- upserts canonical repo rows with shared repo parsing/IDs,
- writes `tenant_repos`,
- marks the `repos` step complete,
- marks indexing pending unless the repo is already ready, and
- triggers the GitHub Actions indexing workflow through
  `repository_dispatch` when `PIPELINE_DISPATCH_*` is configured.

## Step 4: Watch indexing

The admin UI reads `repo_index_status` to show repo progress. When remote
Cloudflare API credentials are present, the Pages Functions can sync remote D1
index status back into the local/admin view before returning the summary.

The Slack command `@bot index status` reads the same status model.

## Step 5: Map CI notification channel

The portal can map a selected repo to a Slack channel through
`/api/admin/channel`. The Slack command equivalent is:

```text
@bot notify owner/repo here
```

For tenant-scoped installs, CI triage claims are deduped per Slack workspace so
multiple tenants can select the same repo without sharing Slack notifications.

## Step 6: First cited answer

Once a tenant gets a cited Slack answer, the Slack bot marks
`first_answer` complete and sets `tenants.onboarding_completed_at`. The admin UI
then treats the setup journey as complete.

## Local mock mode

Local smoke tests do not require real Slack or GitHub OAuth:

```bash
cp site/.dev.vars.example .dev.vars
npm run db:local:init
npm run dev:portal
npm run verify:local
```

Mock endpoints:

- `/api/admin/slack/start?mock=1`
- `/api/admin/github/start?mock=1`

## Current limits

- Data is tenant-scoped in the shared `scintel` D1 database; the repo does not
  provision one D1 database per tenant yet.
- The indexing workflow and Slack-side PR actions still use configured GitHub
  PATs. The GitHub App is used for install linkage, repository selection, and
  automatic webhook-driven indexing.
- Billing, user roles, and strict per-user GitHub permission mirroring are not
  implemented yet.
