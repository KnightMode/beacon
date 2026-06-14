# Local verification (multi-tenant onboarding)

Verify multi-tenant onboarding on your machine before deploying. The default
path uses isolated local D1 state, mock Slack/GitHub OAuth, two mock GitHub App
installations, and local mock indexing. No real Slack, GitHub, Cloudflare, or
PAT credentials are required.

## One-command E2E

```bash
npm install
npm run e2e:local
```

The runner:

- creates fresh local D1 state under `.wrangler/e2e-state`
- starts `wrangler pages dev site` on a free localhost port
- completes mock Slack OAuth
- connects two mock GitHub installations to the same tenant
- lists repos from both installations
- selects repos from both installations
- marks local mock indexing `READY`
- verifies channel setup is not required for onboarding
- runs with `GITHUB_PAT` unset

`npm run verify:local` is kept as a compatibility alias for the same E2E runner.

## Manual portal dev

Use this only when you want to inspect the UI manually while keeping state
between runs.

```bash
npm run db:local:init
npm run dev:portal
```

Wrangler loads secrets from `.dev.vars` at the repo root for `dev:portal`.
The same encryption secret must appear in `workers/slack-bot/.dev.vars` when
testing the bot against the shared local D1.

Cloudflare Access verification is skipped for localhost by default. To exercise
the deployed fail-closed behavior locally, set `ADMIN_CF_ACCESS_ENFORCE_LOCAL=true`
and provide the Access issuer/audience vars in `.dev.vars`.

Open http://127.0.0.1:8788/admin/onboarding/ in a browser. Use the **Connect
Slack** link, or go directly to mock OAuth:

- http://127.0.0.1:8788/api/admin/slack/start?mock=1
- http://127.0.0.1:8788/api/admin/github/start?mock=1 (after Slack mock)
- http://127.0.0.1:8788/api/admin/github/start?mock=1&installation_id=67890&account_login=acme-corp

## Slack bot dev (optional)

To verify the worker reads the same tenant data and per-team tokens:

```bash
npm run dev:bot
```

The bot uses the **same** `.wrangler/state` local D1 as the portal. After mock
OAuth, `getSlackBotToken(env, 'T_BEACON_DEMO')` decrypts the token stored by the
portal (requires matching `SLACK_TOKEN_ENCRYPTION_SECRET` in `.dev.vars` and
`workers/slack-bot/.dev.vars`).

Create `workers/slack-bot/.dev.vars` with at least:

```
SLACK_SIGNING_SECRET=local-dev-signing-secret
SLACK_BOT_TOKEN=xoxb-fallback-token
SLACK_TOKEN_ENCRYPTION_SECRET=local-dev-slack-encryption-secret
GITHUB_APP_ID=your-app-id-if-testing-real-github
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Point Slack event URLs at the `wrangler dev` tunnel URL only when you want to
test real Slack events; the portal flow does not require it.

## Inspect local D1

```bash
npm run db:local:query -- "SELECT id, slack_team_id, status FROM tenants"
npm run db:local:query -- "SELECT tenant_id, repo_id, installation_id, full_name FROM tenant_repos"
```

## What mock mode covers vs. what it does not

| Covered locally | Needs remote / real credentials |
|---|---|
| Tenant schema + migrations | Production D1 (`--remote`) |
| Admin UI + API routes | Cloudflare Pages deploy |
| Mock Slack/GitHub OAuth | Real OAuth redirect URLs |
| Multiple installation repo picker | Real GitHub App installation webhooks/API |
| Local mock indexing status | Hosted indexer (`INDEXER_URL` + `INDEXER_SHARED_SECRET`) |
| Shared local D1 with slack-bot | Slack Events API (needs tunnel + app config) |

## Troubleshooting

**`e2e:local` cannot start Wrangler** — make sure no local security policy is
blocking localhost listeners. In Codex sandboxed sessions, this command may need
escalated permissions because Wrangler writes logs under the user Library and
binds localhost.

**`SLACK_TOKEN_ENCRYPTION_SECRET is required`** — copy `.dev.vars` from the
examples or use `npm run e2e:local`, which injects its own local bindings.

**Schema errors on `db:local:init`** — wipe local state and retry:

```bash
rm -rf .wrangler/state/v3/d1
npm run db:local:init
```

**Manual different port** — `npm run dev:portal -- --port 8790` if port 8788 is
already in use.
