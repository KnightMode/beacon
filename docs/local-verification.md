# Local verification (multi-tenant onboarding)

Verify Phase 1 onboarding on your machine before deploying. Uses **local D1**
(no remote writes) and **mock OAuth** (no real Slack/GitHub apps required for
the portal smoke test).

## One-time setup

```bash
npm install
cp site/.dev.vars.example .dev.vars
npm run db:local:init
```

Wrangler loads secrets from `.dev.vars` at the repo root for `dev:portal`.
The same encryption secret must appear in `workers/slack-bot/.dev.vars` when
testing the bot against the shared local D1.

`db:local:init` applies `schema.sql`, `0004_tenants.sql`, and
`0005_tenant_ci_triage_runs.sql` to the local D1 database under
`.wrangler/state/`. Re-run safely on a fresh machine; if you already have local
data, use `npm run db:local:migrate` instead.

Cloudflare Access verification is skipped for localhost by default. To exercise
the deployed fail-closed behavior locally, set `ADMIN_CF_ACCESS_ENFORCE_LOCAL=true`
and provide the Access issuer/audience vars in `.dev.vars`.

## Terminal 1 — admin portal

```bash
npm run dev:portal
```

Serves the marketing site + Pages Functions at **http://127.0.0.1:8788** with:

- Static files from `site/`
- API routes from `functions/` at the repo root
- D1 binding `DB` → local `scintel` database

Open http://127.0.0.1:8788/admin/onboarding/ in a browser. Use the **Connect
Slack** link, or go directly to mock OAuth:

- http://127.0.0.1:8788/api/admin/slack/start?mock=1
- http://127.0.0.1:8788/api/admin/github/start?mock=1 (after Slack mock)

## Terminal 2 — automated smoke test

With the portal running:

```bash
npm run verify:local
```

This walks through mock Slack OAuth → mock GitHub install → repo selection and
asserts tenant rows and onboarding steps in local D1.

## Terminal 3 — slack-bot (optional)

To verify the worker reads the same tenant data and per-team tokens:

```bash
npm run dev:bot
```

The bot uses the **same** `.wrangler/state` local D1 as the portal. After mock
OAuth, `getSlackBotToken(env, 'T_BEACON_DEMO')` decrypts the token stored by the
portal (requires matching `SLACK_TOKEN_ENCRYPTION_SECRET` in `site/.dev.vars`
and `workers/slack-bot/.dev.vars`).

Create `workers/slack-bot/.dev.vars` with at least:

```
SLACK_SIGNING_SECRET=local-dev-signing-secret
SLACK_BOT_TOKEN=xoxb-fallback-token
SLACK_TOKEN_ENCRYPTION_SECRET=local-dev-slack-encryption-secret
GITHUB_PAT=your-pat-if-testing-index
```

Point Slack event URLs at the `wrangler dev` tunnel URL only when you want to
test real Slack events; the portal flow does not require it.

## Inspect local D1

```bash
npm run db:local:query -- "SELECT id, slack_team_id, status FROM tenants"
npm run db:local:query -- "SELECT tenant_id, repo_id, full_name FROM tenant_repos"
```

## What mock mode covers vs. what it does not

| Covered locally | Needs remote / real credentials |
|---|---|
| Tenant schema + migrations | Production D1 (`--remote`) |
| Admin UI + API routes | Cloudflare Pages deploy |
| Mock Slack/GitHub OAuth | Real OAuth redirect URLs |
| Repo rows in `tenant_repos` | GitHub `repository_dispatch` (set `PIPELINE_DISPATCH_*` in `.dev.vars`) |
| Indexing status in admin UI | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (syncs remote D1 → local on refresh) |
| Shared local D1 with slack-bot | Slack Events API (needs tunnel + app config) |

## Troubleshooting

**`verify:local` cannot reach portal** — start `npm run dev:portal` first.

**`SLACK_TOKEN_ENCRYPTION_SECRET is required`** — copy `site/.dev.vars.example`
to `.dev.vars` at the repo root.

**Schema errors on `db:local:init`** — wipe local state and retry:

```bash
rm -rf .wrangler/state/v3/d1
npm run db:local:init
```

**Different port** — `BASE_URL=http://127.0.0.1:8790 npm run verify:local` if
you started the portal with `--port 8790`.
