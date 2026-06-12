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
# workers/slack-bot:      SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GITHUB_PAT
# workers/github-webhook: GITHUB_WEBHOOK_SECRET, ADMIN_TOKEN, PIPELINE_DISPATCH_TOKEN
npx wrangler secret put <NAME>        # run in each worker directory

npm run deploy --workspace workers/slack-bot
npm run deploy --workspace workers/github-webhook
```

**Repo Actions secrets** for the indexing pipeline: `INDEXER_GITHUB_PAT`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`.

**Key vars** (`wrangler.toml`): `LLM_MODEL`, `EMBEDDING_MODEL`,
`AGENTIC_RETRIEVAL`, `INDEX_DISPATCH_REPO`, `PIPELINE_DISPATCH_REPO`.

## 5. GitHub App (for automatic indexing)

Create one under Settings → Developer settings → GitHub Apps:

- **Webhook URL:** `https://<github-webhook-url>/webhooks/github`
- **Webhook secret:** your `GITHUB_WEBHOOK_SECRET`
- **Permission:** Contents: Read-only
- **Subscribe to:** Push

Install it on the repos you want indexed. Installation triggers the first full
index; pushes keep it fresh.

> Pushes to `main` in this repository also auto-deploy the workers via
> `deploy.yml`.

## Environment reference

See [`.env.example`](../.env.example) for the full set of variables and secrets
across the workers and the indexing pipeline.
