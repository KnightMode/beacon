# Architecture

Beacon is a serverless, two-worker system on Cloudflare with an indexing
pipeline that runs in GitHub Actions. Nothing to operate, nothing to keep warm.

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

## The query path (`workers/slack-bot`)

1. **Verify** the Slack signature on every request.
2. **Route** the intent: question, index command, PR review, PR creation.
3. **Retrieve** evidence with hybrid search:
   - BM25 full-text over code (SQLite FTS5 in D1)
   - vector similarity (Vectorize + `embeddinggemma-300m`, 768d)
   - one-hop expansion over extracted `CALLS` / `IMPORTS` edges
   - merge + rerank with symbol and diversity heuristics
4. **Plan (agentic)** — a planner LLM inspects the first round of results and,
   when something is missing, runs follow-up tools (search, read file, find
   callers/callees over the code graph) before answering. Hard time-budgeted,
   with graceful fallback to single-shot retrieval.
5. **Answer** with an LLM (Workers AI, Kimi), grounded strictly in the
   retrieved evidence, streamed token-by-token into the Slack thread with a
   `Sources` list of `repo/path:lines`. If the evidence isn't there, it says so.

## The indexing path (`workers/github-webhook` + `services/indexer`)

The webhook worker verifies GitHub HMAC signatures, enqueues an index job on a
Cloudflare Queue, and the consumer fires a `repository_dispatch` that kicks off
`.github/workflows/index.yml`. That workflow runs the indexer CLI:

```
fetch tree → tree-sitter chunking → secret redaction → embed → upsert
```

Tree-sitter parsing is too heavy for a request-path Worker, so the indexer is a
standalone Node CLI executed in CI. It can also run as a Docker/HTTP service via
`INDEXER_URL` if you prefer your own compute.

### Chunking by language

- **Go, TypeScript/JavaScript, Python** — full semantic chunking: functions,
  classes, types, imports, and call edges.
- **Markdown** — chunked by heading.
- **Other text** — line windows.

Chunks with obvious credentials are redacted before embedding.

### Incremental reindexing

Every push to the default branch incrementally reindexes only the changed files;
deleted files are cleaned out of the index. Installation of the GitHub App
triggers the first full index.

## Stack

npm-workspaces TypeScript monorepo · Cloudflare Workers, D1 (SQLite + FTS5),
Vectorize, Queues, Workers AI · GitHub Actions for indexing CI ·
`web-tree-sitter` 0.22.x.

```
packages/   shared (schema, types) · eval (answer-quality harness)
services/   indexer (tree-sitter chunking CLI)
workers/    slack-bot · github-webhook
```
