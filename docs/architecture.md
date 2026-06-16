# Architecture

Beacon is a serverless Cloudflare system with two Workers, a Pages admin
portal, shared D1/Vectorize storage, and an indexing pipeline that runs in
GitHub Actions. Nothing to operate, nothing to keep warm.

```
 Cloudflare Pages site
   /admin/onboarding ──Slack OAuth · GitHub App · repo picker──▶ functions/*
                                                                  │
                                                                  ▼
                                                        D1 tenant rows
                                                                  │
 Slack ──/ask-code · @mention · DM · emoji──▶ workers/slack-bot (CF Worker)
                                              │  verify sig → intent routing
                                              │  resolve Slack team → tenant
                                              │  agentic retrieval:
                                              │   Zoekt + SCIP + FTS5(D1)
                                              │   + Vectorize + graph
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
                GitHub Actions: Index Repository workflow
                              │  runs services/indexer CLI and mints
                              │  GitHub App installation token:
                              │  fetch tree → tree-sitter chunking →
                              │  secret redaction → embed → upsert
                              │  optional Zoekt + SCIP artifacts/facts
```

## The query path (`workers/slack-bot`)

1. **Verify** the Slack signature on every request.
2. **Resolve tenant context** from the signed Slack `team_id`. Tenant-scoped
   installs use encrypted bot tokens stored by the admin portal; the static
   `SLACK_BOT_TOKEN` remains a fallback for local/prototype paths.
3. **Route** the intent: question, index command, index status, notify-channel
   mapping, PR review, PR creation.
4. **Retrieve** evidence with hybrid search:
   - Zoekt exact source-code search through the `ZOEKT_SEARCH` service binding
     or `ZOEKT_SEARCH_URL`
   - SCIP definitions/references when normalized facts are populated
   - BM25 full-text over code (SQLite FTS5 in D1)
   - vector similarity (Vectorize + `embeddinggemma-300m`, 768d)
   - one-hop expansion over extracted `CALLS` / `IMPORTS` edges
   - merge + rerank with symbol and diversity heuristics
5. **Plan when needed** — the first hybrid pass is the default fast path. With
   `AGENTIC_PLANNER_MODE=on_demand`, the planner LLM runs when first-pass
   evidence is weak, lacks high-confidence Zoekt/SCIP hits, or the question
   explicitly asks for tracing, references, cross-repo impact, or
   breaking-change analysis. `always` forces deeper planner loops; `off`
   disables them.
6. **Answer** with an LLM (Workers AI, Kimi), grounded strictly in the
   retrieved evidence, streamed token-by-token into the Slack thread with a
   `Sources` list of `repo/path:lines`. If the evidence isn't there, it says so.

## The admin path (`site/` + `functions/`)

The admin portal lives inside the existing Cloudflare Pages site, not a
separate service. Static files are served from `site/`; Pages Functions under
the repo-root `functions/` directory implement the JSON and OAuth routes.

Current onboarding steps:

1. Slack OAuth creates or updates a tenant keyed by Slack workspace/team ID.
   The workspace bot token is encrypted with AES-GCM before storage.
2. GitHub App setup links an installation to that tenant. The repo picker lists
   repositories visible to the installation through short-lived installation
   tokens.
3. Selected repositories are written to `tenant_repos`; indexing is started by
   a GitHub `repository_dispatch` into the indexing workflow.
4. The admin UI shows repo indexing state from `repo_index_status`, supports CI
   notification channel mapping, and marks onboarding complete after the first
   cited answer.

Cloudflare Access protects `/admin`, `/api/admin`, and OAuth callbacks in
deployed environments. Localhost stays usable for `wrangler pages dev`.

## The indexing path (`workers/github-webhook` + `services/indexer`)

The webhook worker verifies GitHub HMAC signatures, stores the installation's
live repo grants, and enqueues index jobs only for tenant-selected repos. Tenant
jobs go to the `Index Repository` GitHub Actions workflow with `tenantId` and
`installationId`. The workflow runs the Node indexer CLI, which mints a
short-lived GitHub App installation token for the selected installation and then
runs:

```
fetch tree → tree-sitter chunking → secret redaction → embed → upsert
```

Tree-sitter parsing, Zoekt shard generation, and SCIP indexer execution are too
heavy for a request-path Worker, so the indexer runs as a Node process in GitHub
Actions. The optional hosted HTTP indexer path is only a fallback for
deployments that choose to operate one.

The indexer writes through Cloudflare REST clients, not Worker bindings. The
REST plumbing is centralized in `services/indexer/src/cloudflare/api.ts`, with
D1, Vectorize, and Workers AI clients layered on top.

Zoekt query serving is separate from generation: a Cloudflare Container runs the
Zoekt search surface for low-latency Slack queries, while GitHub Actions remains
the heavy generation runner. See
[Zoekt + SCIP Code-Intel Foundation](code-intel-foundation.md).

### Chunking by language

- **Go, Java, TypeScript/JavaScript, Python** — full semantic chunking: functions,
  classes, types, imports, and call edges.
- **Markdown** — chunked by heading.
- **Other text** — line windows.

Chunks with obvious credentials are redacted before embedding.

### Incremental reindexing

Every push to the default branch incrementally reindexes only the changed files;
deleted files are cleaned out of the index. Installation of the GitHub App
triggers the first full index.

## Shared package boundaries

`packages/shared` is the cross-runtime contract. It contains:

- D1 schema and migrations.
- Shared TypeScript types for chunks, citations, jobs, and eval data.
- Text, language, hashing, filtering, and embedding helpers.
- Runtime-neutral repo parsing and repo IDs.
- Encoding and AES-GCM secret helpers used by Pages Functions and Workers.
- GitHub REST header and `repository_dispatch` helpers used by the admin portal,
  Slack bot, and webhook worker.

Domain clients stay in their domain packages: Slack API calls live behind
Slack clients in Pages/Slack worker code, while richer GitHub PR/review/indexer
clients remain in `workers/slack-bot/src/github.ts` and
`services/indexer/src/github.ts`.

## Stack

npm-workspaces TypeScript monorepo · Cloudflare Workers, D1 (SQLite + FTS5),
Vectorize, Queues, Workers AI · Cloudflare Pages Functions · GitHub Actions for
indexing CI · `web-tree-sitter` 0.22.x.

```
packages/   shared (schema, types, utilities) · eval (answer-quality harness)
services/   indexer (tree-sitter chunking CLI)
workers/    slack-bot · github-webhook
functions/  Cloudflare Pages admin APIs and OAuth callbacks
site/       marketing site and admin onboarding UI
```
