# Setup

**Prerequisites:** Node ≥ 20, a Cloudflare account, a GitHub account, and a
Slack workspace you can install apps into.

## 1. Cloudflare resources

```bash
npm install
npx wrangler d1 create scintel              # put the id in both workers' wrangler.toml
npx wrangler d1 execute scintel --remote --file=packages/shared/schema.sql
npx wrangler vectorize create code-chunks --dimensions=768 --metric=cosine
npx wrangler queues create scintel-index-jobs
npx wrangler queues create scintel-index-jobs-dlq
```

Databases created before FTS5 existed need the one-time, idempotent migration:

```bash
npx wrangler d1 execute scintel --remote --file=packages/shared/migrations/0001_chunks_fts.sql
```

Multi-tenant admin portal support needs the tenant migration:

```bash
npx wrangler d1 execute scintel --remote --file=packages/shared/migrations/0004_tenants.sql
npx wrangler d1 execute scintel --remote --file=packages/shared/migrations/0005_tenant_ci_triage_runs.sql
```

## 2. GitHub PAT

Create a fine-grained PAT with **Contents: Read** on every repo you want
indexed (plus **Pull requests: Write** if you use PR creation).

> The PAT's repo list is the hard boundary of what can be indexed.

## 3. Slack app

Create one at [api.slack.com/apps](https://api.slack.com/apps):

- **Slash command** `/ask-code` → `https://<slack-bot-url>/slack/commands`
- **Event Subscriptions** → `https://<slack-bot-url>/slack/events`, with bot
  events: `app_mention`, `message.im`, `reaction_added`,
  `assistant_thread_started`
- **Bot scopes:** `commands`, `app_mentions:read`, `chat:write`,
  `reactions:read`, `channels:history`, `im:history`

## 4. Secrets & deploy

```bash
# workers/slack-bot bootstrap secrets:
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN

# workers/github-webhook bootstrap secrets:
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put PIPELINE_DISPATCH_TOKEN

npm run deploy --workspace workers/slack-bot
npm run deploy --workspace workers/github-webhook
```

The `Deploy Workers` GitHub Actions workflow automatically syncs the
deploy-managed slack-bot secrets from repo secrets before each slack-bot deploy:
`SLACK_TOKEN_ENCRYPTION_SECRET`, `INDEXER_GITHUB_PAT` as Worker `GITHUB_PAT`,
and `EVAL_TOKEN`.

For the Cloudflare Pages admin portal, the `Configure site Access` workflow
updates the Pages project and redeploys it with:

- **D1 binding:** `DB` pointing at the same `scintel` database.
- **D1 tenant migrations:** `0004_tenants.sql` and
  `0005_tenant_ci_triage_runs.sql` applied to the remote database.
- **Secrets from GitHub Actions:** `ADMIN_SESSION_SECRET`, `SLACK_CLIENT_SECRET`,
  `SLACK_TOKEN_ENCRYPTION_SECRET`, and optionally `PIPELINE_DISPATCH_TOKEN` and
  `BEACON_GITHUB_APP_PRIVATE_KEY` (written to Pages as `GITHUB_APP_PRIVATE_KEY`).
- **Vars:** `SLACK_CLIENT_ID`, `GITHUB_APP_SLUG`, `PIPELINE_DISPATCH_REPO`, and
  `PIPELINE_DISPATCH_EVENT`.
- **Cloudflare Access vars:** `ADMIN_CF_ACCESS_ISSUER` and
  `ADMIN_CF_ACCESS_AUD` are required for deployed admin routes. Optionally set
  `ADMIN_CF_ACCESS_ALLOWED_EMAILS` or `ADMIN_CF_ACCESS_ALLOWED_DOMAINS` for an
  in-app allow-list that mirrors the Access policy.

The Slack OAuth redirect URL is
`https://askbeacon.dev/oauth/slack/callback`. The GitHub App setup callback is
`https://askbeacon.dev/oauth/github/callback`.

If Slack OAuth redirects back with `Cannot read properties of undefined
(reading 'batch')`, the Pages deployment does not have the `DB` binding yet.
Rerun `Configure site Access` and keep the default D1 values unless you created
a different database.

If Slack OAuth redirects back with `D1_ERROR: no such table: tenants`, the
remote database is missing the admin tenant migrations. `Configure site Access`
now applies those migrations automatically before deploying Pages.

Admin portal Pages Functions live at `functions/` (repo root). Wrangler reads
that directory from the project root when you run `wrangler pages dev site` or
`wrangler pages deploy site`. For local verification before deploy, see
[local-verification.md](local-verification.md). Quick start:

```bash
cp site/.dev.vars.example .dev.vars
npm run db:local:init
npm run dev:portal          # terminal 1
npm run verify:local        # terminal 2
```

For local UI testing without real OAuth, append `?mock=1` to
`/api/admin/slack/start` or `/api/admin/github/start`.

**Repo Actions secrets** for the indexing pipeline: `INDEXER_GITHUB_PAT`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`.

**Key vars** (`wrangler.toml`): `LLM_MODEL`, `EMBEDDING_MODEL`,
`AGENTIC_RETRIEVAL`, `INDEX_DISPATCH_REPO`, `PIPELINE_DISPATCH_REPO`.

## 5. GitHub App (for automatic indexing)

Create one under [GitHub → Settings → Developer settings → GitHub Apps](https://github.com/settings/apps/new):

- **GitHub App name:** e.g. `Beacon` (pick any name)
- **Homepage URL:** `https://askbeacon.dev` (or `http://localhost:8788` for local dev)
- **Setup URL (OAuth callback):** `http://localhost:8788/oauth/github/callback` for local dev,
  or `https://askbeacon.dev/oauth/github/callback` in production
- **Redirect on update:** enable this so saving repo access on GitHub sends users back to onboarding
- **Webhook URL:** `https://<github-webhook-url>/webhooks/github`
- **Webhook secret:** your `GITHUB_WEBHOOK_SECRET`
- **Permission:** Contents: Read-only
- **Subscribe to:** Push, and installation events if offered

After creating the app, copy its **slug** from the app settings URL
(`https://github.com/settings/apps/<slug>`) into `.dev.vars`:

```bash
GITHUB_APP_SLUG=<slug>
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` power the onboarding repo picker
(listing repos from the customer's GitHub install). Generate a new private key
in the app settings if you do not have one yet.

For the GitHub Actions `Configure site Access` workflow, use repository variable
`BEACON_GITHUB_APP_ID` and repository secret `BEACON_GITHUB_APP_PRIVATE_KEY`;
the workflow writes them into Pages as `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY`.

For local `.dev.vars`, keep the private key on **one line** with literal `\n`
between PEM lines (multiline values are unreliable in dotenv files):

```bash
node scripts/format-github-private-key.mjs ~/Downloads/your-app.private-key.pem
```

Paste the printed line into `.dev.vars`, then restart `npm run dev:portal`.

Restart `npm run dev:portal` after changing `.dev.vars`.

> Pushes to `main` in this repository also auto-deploy the workers via
> `deploy.yml`.

## 6. Admin portal Access

The marketing site deploys from `site/` to Cloudflare Pages, but the sensitive
admin surface is path-scoped behind Cloudflare Access. To require email one-time
PIN login for `/admin`, `/api/admin`, and the OAuth callbacks, run the manual
`Configure site Access` GitHub Actions workflow with the allowed emails or email
domains. The workflow creates the Access apps and writes the required
`ADMIN_CF_ACCESS_*` runtime vars into the Pages project. See
[Protect the admin portal with Cloudflare Access](./site-access.md).

## Environment reference

See [`.env.example`](../.env.example) for the full set of variables and secrets
across the workers and the indexing pipeline.
