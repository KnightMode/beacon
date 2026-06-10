# Slack Code Intelligence Bot

**Ask your codebase anything — from Slack, with answers grounded in your actual
code and cited down to the file and line.**

```
you   ▸ @bot why does the create-PR flow go through a queue instead of waitUntil?
bot   ▸ Because Cloudflare cancels waitUntil work ~30s after the response is
        sent, and PR creation (LLM edit generation + GitHub API calls) can
        exceed that [1][2]. The slash handler enqueues a job instead…
        Sources: workers/slack-bot/wrangler.toml:31-38 · src/actions/createPr.ts:24-61
```

## The problem

Engineering knowledge lives in code, but questions get asked in Slack. The gap
is filled by interrupting whoever wrote the code, spelunking through repos, or
trusting an LLM that has never seen your codebase and invents plausible
nonsense. Generic AI assistants can't cite your code; code search can't answer
questions.

This bot closes the gap: it indexes your GitHub repos into a semantic +
lexical + call-graph index, retrieves real evidence for every question, and
answers **only from that evidence** — with clickable citations, in the Slack
thread where the question was asked.

## What it does

- **Grounded Q&A** — `/ask-code <question>` or `@bot <question>` in channels,
  DMs, and the Slack assistant pane. Answers stream in token-by-token with a
  `Sources` list (`repo/path:lines`). Thread history is used to resolve
  follow-ups. If the evidence isn't there, it says so instead of guessing.
- **Agentic retrieval** — a planner LLM inspects the first round of search
  results and, when something is missing, runs follow-up tools (search, read
  file, find callers/callees over the code graph) before answering. Multi-hop
  "why/how" questions get traced, not guessed. Hard time-budgeted with
  graceful fallback to single-shot retrieval.
- **Hybrid search** — BM25 full-text (SQLite FTS5), vector similarity
  (Vectorize + `embeddinggemma-300m`), and one-hop expansion over extracted
  `CALLS`/`IMPORTS` edges, merged and reranked with symbol/diversity
  heuristics.
- **PR review** — paste a PR URL (or react with an emoji) and get a streamed
  review informed by the indexed codebase.
- **PR creation** — describe an issue in a thread, react with :rocket: (or say
  `create pr: …`), and the bot proposes file edits and opens a pull request.
- **Self-serve indexing** — `@bot index owner/repo` onboards a repo from
  Slack; `index status` shows live progress per repo.
- **Fully automatic indexing** — install the companion GitHub App on a repo
  and it's indexed with no commands at all; every push to the default branch
  incrementally reindexes only the changed files (deleted files are cleaned
  out). Indexing runs as a GitHub Actions pipeline — no servers to operate.

## Architecture

```
 Slack ──/ask-code · @mention · DM · emoji──▶ workers/slack-bot (CF Worker)
                                              │  verify sig → intent routing
                                              │  agentic retrieval:
                                              │   FTS5(D1) + Vectorize + graph
                                              │   → planner tools → rerank
                                              │  LLM answer (Workers AI, Kimi)
                                              │  streamed + cited to Slack
                                              ▼
                       D1 (repos/chunks/edges/FTS) · Vectorize (768d vectors)
                                              ▲
                                              │ writes (Cloudflare REST)
 GitHub App ──install/push──▶ workers/github-webhook (CF Worker)
                              │  HMAC verify → enqueue index job (CF Queue)
                              │  consumer → repository_dispatch
                              ▼
                .github/workflows/index.yml (GitHub Actions)
                              │  runs services/indexer CLI:
                              │  fetch tree → tree-sitter chunking →
                              │  secret redaction → embed → upsert
```

Tree-sitter parsing is too heavy for a request-path Worker, so the indexer is
a standalone Node CLI executed in CI (it can also run as a Docker/HTTP service
via `INDEXER_URL` if you prefer your own compute). Go, TypeScript/JavaScript,
and Python get full semantic chunking (functions, classes, types, imports,
call edges); markdown is chunked by heading; other text by line windows.
Chunks with obvious credentials are redacted before embedding.

**Stack:** npm-workspaces TypeScript monorepo · Cloudflare Workers, D1
(SQLite + FTS5), Vectorize, Queues, Workers AI · GitHub Actions for indexing
CI · `web-tree-sitter` 0.22.x.

## Setup

Prereqs: Node ≥ 20, a Cloudflare account, a GitHub account, a Slack workspace
you can install apps into.

1. **Cloudflare resources**
   ```bash
   npm install
   npx wrangler d1 create scintel              # put the id in both workers' wrangler.toml
   npx wrangler d1 execute scintel --remote --file=packages/shared/schema.sql
   npx wrangler vectorize create code-chunks --dimensions=768 --metric=cosine
   npx wrangler queues create scintel-index-jobs
   npx wrangler queues create scintel-index-jobs-dlq
   ```
   Databases created before FTS5 existed need the one-time, idempotent
   migration: `npx wrangler d1 execute scintel --remote --file=packages/shared/migrations/0001_chunks_fts.sql`.

2. **GitHub PAT** — fine-grained, **Contents: Read** on every repo you want
   indexed (plus **Pull requests: Write** if you use PR creation). The PAT's
   repo list is the hard boundary of what can be indexed.

3. **Slack app** — create at api.slack.com/apps: slash command `/ask-code` →
   `https://<slack-bot-url>/slack/commands`; Event Subscriptions →
   `https://<slack-bot-url>/slack/events` with bot events `app_mention`,
   `message.im`, `reaction_added`, `assistant_thread_started`; bot scopes
   `commands`, `app_mentions:read`, `chat:write`, `reactions:read`,
   `channels:history`, `im:history`.

4. **Secrets & deploy**
   ```bash
   # workers/slack-bot:   SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GITHUB_PAT
   # workers/github-webhook: GITHUB_WEBHOOK_SECRET, ADMIN_TOKEN, PIPELINE_DISPATCH_TOKEN
   npx wrangler secret put <NAME>        # in each worker directory
   npm run deploy --workspace workers/slack-bot
   npm run deploy --workspace workers/github-webhook
   ```
   Repo Actions secrets for the indexing pipeline: `INDEXER_GITHUB_PAT`,
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`. Key vars (wrangler.toml):
   `LLM_MODEL`, `EMBEDDING_MODEL`, `AGENTIC_RETRIEVAL`, `INDEX_DISPATCH_REPO`,
   `PIPELINE_DISPATCH_REPO`.

5. **GitHub App (for automatic indexing)** — create one (Settings → Developer
   settings → GitHub Apps): webhook URL
   `https://<github-webhook-url>/webhooks/github`, your webhook secret,
   permission Contents: Read-only, subscribe to **Push**. Install it on the
   repos you want indexed — installation triggers the first full index;
   pushes keep it fresh. (Pushes to `main` here also auto-deploy the workers
   via `deploy.yml`.)

## Using it

| In Slack | What happens |
|---|---|
| `@bot <question>` / `/ask-code <q>` | streamed, cited answer from the index |
| `@bot index owner/repo` | validate, allowlist, full-index a repo |
| `@bot index status` | live indexing progress for every repo |
| `review <pr-url>` (or emoji on a PR link) | streamed PR review |
| `create pr: <issue>` (or :rocket: on a thread) | LLM-proposed pull request |

Indexing can also be triggered manually: the Actions tab (`Index Repository` →
run workflow), `POST /admin/index` on the webhook worker, or locally with
`npm run index --workspace services/indexer -- owner/repo`.

## Security model

Slack and GitHub signatures are verified on every request. Retrieved code is
treated strictly as untrusted data in prompts (instruction-injection
resistance). Secrets are redacted before embedding. **Prototype auth:** one
PAT indexes; all Slack users can query everything on the allowlist — the
`users` / `github_user_repo_permissions` tables and the per-repo retrieval
filter are the extension points for per-user GitHub OAuth when you need real
access control.

## Roadmap to world-class

Foundations are in place; these are the highest-leverage next steps, roughly
in order:

1. **Eval harness** — a golden set of real questions with expected citations,
   scored in CI (citation precision/recall + LLM-judge). Every retrieval
   change becomes measurable instead of vibes.
2. **Feedback loop** — capture :+1:/:-1: on answers into D1 to grow the eval
   set from real usage and surface bad-answer patterns.
3. **Cross-encoder reranking** — a real reranker over the top ~50 candidates
   before context packing; the highest ROI-per-line change left in retrieval.
4. **Frontier answer model** — route the final answer (and the agent planner)
   to a stronger model; retrieval quality is increasingly ahead of the
   8–30B-class models summarizing it.
5. **Permission-aware retrieval** — per-user GitHub OAuth + permission sync so
   each Slack user only sees repos they can access (schema already supports it).
6. **Index the conversation, not just the code** — PR descriptions, review
   threads, and issues hold the "why" that code can't express.
7. **Deeper code graph** — cross-file/cross-repo symbol resolution and
   multi-hop traversal to power richer agent tools.
8. **Observability** — log query → retrieved chunks → answer with stage
   latencies (Workers Analytics Engine) for debugging and eval mining.
9. **Code-tuned embeddings** — swap in a code-specialized model if the eval
   harness shows retrieval misses (requires reindex; measure first).
10. **Multi-branch & monorepo awareness** — index non-default branches and
    scope queries by path or service.

## Development

```bash
npm run typecheck      # all workspaces
npm test               # vitest: signatures, chunking, filters, retrieval, intents
npm run dry-run        # wrangler deploy --dry-run for both workers
```

MIT licensed.
