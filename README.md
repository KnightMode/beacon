# Slack Code Intelligence Bot

A Slack bot that answers questions across multiple GitHub repositories using a
pre-built code index. Code is parsed with **tree-sitter**, embedded with
**Cloudflare Workers AI**, stored in **Cloudflare Vectorize** (vectors) +
**Cloudflare D1** (metadata + graph edges), and queried through a
retrieval-augmented pipeline that returns answers with **file + line citations**.

This is an **MVP prototype** (spec section 19). It uses a deliberately simple
auth model:

> **Prototype auth:** ONE GitHub identity (a fine-grained PAT) owns indexing.
> All Slack users can query a **static repo allowlist**. There is no per-user
> GitHub permission checking. See [Prototype vs Production auth](#prototype-vs-production-auth).

---

## Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │                  Slack                         │
                         │   /ask-code <q>        @bot mention            │
                         └───────────────┬───────────────┬───────────────┘
                                         │ (signed)      │ (signed)
                                         ▼               ▼
                         ┌──────────────────────────────────────────────┐
                         │   workers/slack-bot   (Cloudflare Worker)      │
                         │   • verify Slack signature (v0, 5-min skew)    │
                         │   • ack <3s, finish via ctx.waitUntil          │
                         │   • retrieval: lexical(D1) + vector(Vectorize) │
                         │     + graph(code_edges) → rerank → pack        │
                         │   • LLM answer (Workers AI) w/ citations       │
                         └───────┬──────────────┬───────────────┬────────┘
                                 │ D1           │ Vectorize     │ Workers AI
                                 ▼              ▼               ▼
                         ┌─────────────┐ ┌─────────────┐ ┌──────────────┐
                         │  D1 (SQL)   │ │  Vectorize  │ │  Workers AI  │
                         │ repos,files │ │ code-chunks │ │ embeddings + │
                         │ chunks,edges│ │ (768 dims)  │ │ llama answer │
                         └─────▲───────┘ └─────▲───────┘ └──────▲───────┘
                               │               │ writes (REST)  │
                               │ writes (REST) │                │ embeddings (REST)
                               │         ┌─────┴────────────────┴──────┐
                               └─────────┤  services/indexer (Node)     │
                                         │  • GitHub REST: tree+blobs   │
                                         │  • tree-sitter chunking      │
                                         │  • markdown heading chunking │
                                         │  • secret redaction          │
                                         │  • embed + upsert vectors    │
                                         │  HTTP POST /index   +  CLI    │
                                         └─────────────▲────────────────┘
                                                       │ POST /index (bearer)
                         ┌─────────────────────────────┴────────────────┐
                         │  workers/github-webhook (Cloudflare Worker)    │
                         │  • POST /webhooks/github (HMAC verify)         │
                         │    installation/push → enqueue index jobs      │
                         │  • POST /admin/index (bearer) manual enqueue   │
                         │  • Queue consumer → calls indexer /index       │
                         └───────────────────────┬───────────────────────┘
                                                 │ produces + consumes
                                                 ▼
                                       ┌──────────────────────┐
                                       │ Cloudflare Queue      │
                                       │ scintel-index-jobs    │
                                       └──────────────────────┘
                                                 ▲
                                                 │ GitHub webhooks (App, optional)
                                       ┌──────────────────────┐
                                       │       GitHub          │
                                       └──────────────────────┘
```

**Why a separate Node indexer?** Tree-sitter parsing must NOT run inside a
request Worker (no native/wasm-heavy parsing in the request path). The indexer
is a standalone Node + TypeScript service (with a `Dockerfile`) that does the
heavy parsing/embedding and writes to D1 / Vectorize via the Cloudflare REST
API. The webhook worker's queue consumer is a thin dispatcher that calls the
indexer over HTTP.

---

## Repository layout

```
slack-code-intelligence/
├── package.json                  # npm workspaces root
├── tsconfig.base.json            # shared TS compiler options
├── .env.example                  # every secret/var, documented
├── packages/
│   └── shared/                   # types, schema.sql, constants, pure utils
│       ├── schema.sql            # ← the D1 schema (all tables + indexes)
│       └── src/
│           ├── types.ts          # job/chunk/edge/D1-row/retrieval types
│           ├── constants.ts      # chunk types, edge types, statuses, ignore lists
│           └── utils/            # hash, language, fileFilter, secrets, embeddingText
├── workers/
│   ├── github-webhook/           # webhook verify + handlers + admin + queue consumer
│   └── slack-bot/                # signature verify + retrieval + LLM + Slack format
└── services/
    └── indexer/                  # GitHub fetch + tree-sitter + embed + write (Node)
        ├── Dockerfile
        └── src/{server.ts, cli.ts, chunking/, cloudflare/, core/}
```

---

## Tech stack

- **Monorepo:** npm workspaces, TypeScript everywhere.
- **Workers:** Cloudflare Workers (TS) — `workers/github-webhook`, `workers/slack-bot`.
- **Queue:** Cloudflare Queue (`scintel-index-jobs`); the webhook worker is both
  producer and consumer; the consumer forwards jobs to the indexer.
- **DB:** Cloudflare D1 (SQLite) for metadata + graph edges.
- **Vectors:** Cloudflare Vectorize (`768` dims, cosine).
- **AI:** Workers AI — embeddings `@cf/google/embeddinggemma-300m`, LLM
  `@cf/moonshotai/kimi-k2.6` (both configurable via env vars).
- **Indexer:** Node + TypeScript with `web-tree-sitter` (pinned to `0.22.x`) and
  prebuilt grammar wasm from `tree-sitter-wasms`. Languages with full
  tree-sitter chunking: **Go, TypeScript/JavaScript, Python**. Markdown is
  heading-chunked; other recognized text files get a generic line-window chunker.

---

## What it does (MVP scope)

1. `/ask-code <question>` slash command + `@bot` app_mention handling.
2. GitHub access via a fine-grained PAT (GitHub App support is stubbed).
3. Static repo allowlist in D1 (`prototype_repo_allowlist`) + env seed.
4. Background FULL_INDEX of repos (and INCREMENTAL on push).
5. Tree-sitter code chunks: functions, methods, classes/structs, types/interfaces, imports, calls.
6. Markdown chunking by headings.
7. Vector search via Vectorize.
8. Graph edges: `IMPORTS` and `CALLS` in the `code_edges` table.
9. LLM answer with citations (`repo/path:start-end`).
10. Slack: ack immediately, then post the final answer (slash → `response_url`,
    mention → Web API `chat.postMessage`).

**Intentionally skipped** (left as extension points): per-user GitHub OAuth,
permission sync, admin dashboard, PR generation, multi-branch indexing, issue/PR
indexing, deep call graph. The `users` and `github_user_repo_permissions` tables
exist in the schema for future production auth.

---

## Setup — step by step

Prerequisites: Node ≥ 20, npm, a Cloudflare account, a GitHub account, a Slack
workspace where you can install an app. `wrangler` is available via `npx`.

### 0. Install

```bash
npm install
```

> If npm complains about a root-owned cache, install with a local cache:
> `npm install --cache "$PWD/.npm-cache"`.

### 1. Create the Cloudflare resources

```bash
# D1 database — copy the printed database_id into BOTH wrangler.toml files
npx wrangler d1 create scintel

# Apply the schema (run for --local during dev and/or --remote for prod)
npx wrangler d1 execute scintel --remote --file=packages/shared/schema.sql

# Vectorize index — MUST be 768 dims, cosine
npx wrangler vectorize create code-chunks --dimensions=768 --metric=cosine

# Queue (+ a dead-letter queue referenced by the consumer config)
npx wrangler queues create scintel-index-jobs
npx wrangler queues create scintel-index-jobs-dlq
```

Paste the D1 `database_id` into:
- `workers/github-webhook/wrangler.toml`
- `workers/slack-bot/wrangler.toml`

(Both must point at the **same** D1 database. Search for `REPLACE_WITH_D1_DATABASE_ID`.)

### 2. Create a GitHub fine-grained PAT

GitHub → Settings → Developer settings → Fine-grained tokens. Grant
**Repository contents: Read-only** on the repos you want to index. Save the token
as `GITHUB_PAT`. (Optional GitHub App webhooks are stubbed; the prototype works
fine with just the PAT + the admin endpoint.)

### 3. Create a Slack app + slash command

1. Create an app at <https://api.slack.com/apps> (from scratch).
2. **Slash Commands** → create `/ask-code` → Request URL:
   `https://<slack-bot-worker-url>/slack/commands`.
3. **Event Subscriptions** → enable → Request URL:
   `https://<slack-bot-worker-url>/slack/events` (Slack will send a
   `url_verification` challenge, which the worker answers automatically once the
   signing secret is set and the worker is deployed). Subscribe to bot event
   `app_mention`.
4. **OAuth & Permissions** → bot scopes: `commands`, `app_mentions:read`,
   `chat:write`. Install to workspace; copy the **Bot User OAuth Token**
   (`xoxb-…`) → `SLACK_BOT_TOKEN`, and the **Signing Secret** → `SLACK_SIGNING_SECRET`.
5. (Optional) put the bot's user id in `SLACK_BOT_USER_ID` (var) so mentions are
   stripped cleanly.

### 4. Set Worker secrets

```bash
# github-webhook worker
cd workers/github-webhook
npx wrangler secret put GITHUB_WEBHOOK_SECRET   # random string; reuse in GitHub App if used
npx wrangler secret put ADMIN_TOKEN             # random string for /admin/index
npx wrangler secret put INDEXER_SHARED_SECRET   # random string shared with the indexer
# also set INDEXER_URL in wrangler.toml [vars] to your deployed indexer URL

# slack-bot worker
cd ../slack-bot
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
```

### 5. Deploy the Workers

```bash
npm run deploy --workspace workers/github-webhook
npm run deploy --workspace workers/slack-bot
```

Use the printed slack-bot URL to fill in the Slack slash command / events
Request URLs from step 3.

### 6. Run the indexer

The indexer needs the Cloudflare REST credentials (it is a Node process, not a
Worker). Create `services/indexer/.env` from `.env.example` and fill in
`GITHUB_PAT`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_VECTORIZE_INDEX`, `INDEXER_SHARED_SECRET`.

**Option A — run a one-off full index manually (simplest):**

```bash
npm run index --workspace services/indexer -- your-org/your-repo
```

**Option B — run the indexer as an HTTP service (for the queue path):**

```bash
npm run start --workspace services/indexer            # or build the Docker image:
docker build -f services/indexer/Dockerfile -t scintel-indexer .
docker run --rm -p 8787:8787 --env-file services/indexer/.env scintel-indexer
```

Then enqueue a FULL_INDEX through the webhook worker's admin endpoint (this also
adds the repo to the allowlist):

```bash
curl -X POST https://<github-webhook-url>/admin/index \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"repo":"your-org/your-repo"}'
```

> The CLI (Option A) writes directly to D1/Vectorize but does **not** add the
> repo to `prototype_repo_allowlist`. Seed the allowlist either via the admin
> endpoint, or by inserting a row (the indexer upserts the `repos` row, so the
> `repo_id` is `lower(owner/name)`).

### 7. Ask a question

In Slack: `/ask-code where do we verify the GitHub webhook signature?`
or `@yourbot how does the retrieval pipeline rerank chunks?`

### 8. Add repos from Slack (self-serve indexing)

- `@yourbot index owner/repo` — validates the repo, allowlists it, and runs a
  full index via the `index.yml` GitHub Actions workflow (`repository_dispatch`).
  Requires: the `INDEXER_GITHUB_PAT` / `CLOUDFLARE_*` Actions secrets on the
  repo named in `INDEX_DISPATCH_REPO`, and both that PAT and the bot's
  `GITHUB_PAT` granted read access to the target repo.
- `@yourbot index status` — per-repo indexing progress (PENDING / INDEXING
  with file counts / READY / FAILED with the error).

Both also work via `/ask-code index …` and in the assistant pane.

---

## Environment variable reference

| Name | Where | Secret? | Purpose |
|------|-------|---------|---------|
| `GITHUB_PAT` | indexer | yes | Fine-grained PAT for reading repo contents |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_INSTALLATION_ID` | indexer | priv key yes | Optional GitHub App (stubbed; falls back to PAT) |
| `GITHUB_WEBHOOK_SECRET` | github-webhook | yes | Verify `X-Hub-Signature-256` |
| `ADMIN_TOKEN` | github-webhook | yes | Bearer for `POST /admin/index` |
| `INDEXER_SHARED_SECRET` | github-webhook + indexer | yes | Bearer for queue→indexer `/index` |
| `INDEXER_URL` | github-webhook | no (var) | Base URL of the indexer HTTP service |
| `SLACK_SIGNING_SECRET` | slack-bot | yes | Verify Slack `v0=` signatures |
| `SLACK_BOT_TOKEN` | slack-bot | yes | `chat.postMessage` for mentions |
| `SLACK_BOT_USER_ID` | slack-bot | no (var) | Strip leading mention from text |
| `CLOUDFLARE_ACCOUNT_ID` | indexer | no | REST API account id |
| `CLOUDFLARE_API_TOKEN` | indexer | yes | REST API token (D1 + Vectorize + AI) |
| `CLOUDFLARE_D1_DATABASE_ID` | indexer | no | D1 database id for REST writes |
| `CLOUDFLARE_VECTORIZE_INDEX` | indexer | no | Vectorize index name (default `code-chunks`) |
| `EMBEDDING_MODEL` | indexer + slack-bot | no | default `@cf/baai/bge-base-en-v1.5` |
| `EMBEDDING_DIMENSIONS` | indexer | no | default `768` |
| `LLM_MODEL` | slack-bot | no | default `@cf/moonshotai/kimi-k2.6` |
| `AGENTIC_RETRIEVAL` | slack-bot | no (var) | `"false"` disables the Q&A planner loop |
| `REPO_ALLOWLIST` | github-webhook | no (var) | Comma-separated `owner/name` seed |

See [`.env.example`](./.env.example) for the full annotated list.

---

## Endpoints

**github-webhook**
- `POST /webhooks/github` — HMAC-verified GitHub events (`installation`,
  `installation_repositories`, `push`).
- `POST /admin/index` — `Authorization: Bearer <ADMIN_TOKEN>`, body
  `{"repo":"owner/name"}` → upserts repo, allowlists it, enqueues FULL_INDEX.
- `GET /health`.

**slack-bot**
- `POST /slack/commands` — `/ask-code` slash command.
- `POST /slack/events` — Events API (`url_verification`, `app_mention`).
- `GET /health`.

**indexer**
- `POST /index` — `Authorization: Bearer <INDEXER_SHARED_SECRET>`, body is an
  `IndexJob`. Runs the index and returns counts.
- `GET /health`.

---

## How indexing works

1. Fetch the repo's git tree at HEAD (or a given commit) + blob contents via the
   GitHub REST API.
2. Filter files (ignore `node_modules`, `vendor`, `dist`, `build`, `target`,
   `.git`, lockfiles, binaries, images, minified, oversized — see
   `packages/shared/src/constants.ts` + `utils/fileFilter.ts`).
3. Detect language by extension. Code → tree-sitter chunker; markdown → heading
   chunker; other recognized text → generic line-window chunker.
4. Tree-sitter extracts semantic chunks (functions/methods/classes/structs/
   types/interfaces), an aggregated import chunk, and `IMPORTS`/`CALLS` edges.
5. Secret scanning: chunks containing obvious credentials are **redacted**
   before embedding (`utils/secrets.ts`).
6. Build metadata-enriched embedding text (Repo/Path/Language/Chunk type/Symbol/
   Imports/Calls + Code — spec section 6), embed via Workers AI, upsert vectors
   to Vectorize with metadata.
7. Write `files`, `chunks`, and `code_edges` to D1; advance
   `repos.indexing_status` / `repo_index_status`: `PENDING → INDEXING → READY/FAILED`.

**Incremental (push) semantics:** the webhook collects changed + removed files.
The indexer does **delete-old-then-reindex**: for each changed file it deletes
the file's existing chunks + vectors, then re-chunks/re-embeds current content;
removed files just have their chunks/vectors deleted.

## How answering works

Q&A uses an **agentic retrieval loop** (default; set `AGENTIC_RETRIEVAL = "false"`
on the slack-bot worker to force single-shot):

1. **Turn 0** runs the standard hybrid search: lexical search (D1 **FTS5**,
   BM25-ranked over symbol/path/content) + vector search (Vectorize), hydrated
   from D1.
2. A small **LLM planner** inspects the evidence and may request up to 3 rounds
   of follow-up tools — `search`, `read_file`, `callers`, `callees` (the latter
   two over `code_edges`) — to chase missing definitions or callers.
3. The pooled evidence goes through `rerank (exact-symbol boost, chunk-type
   diversity, semantic score) → context packing → LLM answer with citations`.

Any planner failure degrades gracefully: the bot answers with the evidence
gathered so far, and a hard failure falls back to the single-shot pipeline
(`query understanding (heuristic) → lexical + vector → graph expansion (1 hop)
→ rerank → pack → LLM`).

**FTS5 migration:** databases created before `chunks_fts` existed need a one-time
migration (creates the FTS table + sync triggers and backfills existing chunks):

```bash
npx wrangler d1 execute scintel --remote --file=packages/shared/migrations/0001_chunks_fts.sql
```

Retrieval is filtered to `repo_id IN (allowlist)`. The LLM system prompt treats
repository content strictly as **data, not instructions** (prompt-injection
protection), requires answering only from context, citing `repo/path:start-end`,
separating facts from inference, and admitting missing evidence.

---

## Prototype vs Production auth

- **Prototype (this repo):** a single GitHub PAT indexes everything; every Slack
  user can query any repo in `prototype_repo_allowlist`. No per-user checks.
- **Production (extension points already in place):** the `users` and
  `github_user_repo_permissions` tables, plus the `repo_id IN (...)` filter in
  retrieval, are where you would plug in per-user GitHub OAuth + permission sync
  so that each Slack user only retrieves chunks from repos they can actually see.

---

## Development

```bash
npm run typecheck                 # tsc --noEmit across all workspaces
npm test                          # vitest across all workspaces
npm run dry-run                   # wrangler deploy --dry-run for both workers
npm run index --workspace services/indexer -- --help
```

Unit tests cover signature verification (GitHub + Slack), file filtering,
language detection, secret scanning, and markdown chunking.

---

## Notes & limitations

- `web-tree-sitter` is pinned to `0.22.x` to stay ABI-compatible with the
  prebuilt grammars in `tree-sitter-wasms`. Newer runtimes (0.25+) reject those
  wasm files.
- D1 writes from the indexer go statement-by-statement over REST for simplicity;
  for large repos you'd batch these.
- The `wrangler.toml` files contain placeholder IDs marked
  `REPLACE_WITH_D1_DATABASE_ID` — fill them in before deploying.
- Workers AI / Vectorize REST endpoints and model availability depend on your
  Cloudflare account; model ids are configurable via env vars.
