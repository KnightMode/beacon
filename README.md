
<p align="center">
  <img src="docs/assets/beacon-logo.png" alt="Beacon — codebase intelligence" width="320">
</p>

<p align="center">
  <strong>The agentic dev loop, in Slack — cited answers, PR reviews, fix PRs,
  and CI triage, grounded in your actual code down to the file and line.</strong>
</p>

<p align="center">
  <a href="https://askbeacon.dev"><strong>Website</strong></a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/setup.md">Setup</a> ·
  <a href="docs/usage.md">Usage</a> ·
  <a href="docs/security.md">Security</a> ·
  <a href="docs/roadmap.md">Roadmap</a> ·
  <a href="LICENSE">License</a>
</p>

## Demo

https://github.com/user-attachments/assets/011c8d06-e78d-4856-93fd-5f3bab9542a6

```
you   ▸ @bot why does the create-PR flow go through a queue instead of waitUntil?
bot   ▸ Because Cloudflare cancels waitUntil work ~30s after the response is
        sent, and PR creation (LLM edit generation + GitHub API calls) can
        exceed that [1][2]. The slash handler enqueues a job instead…
        Sources: workers/slack-bot/wrangler.toml:31-38 · src/actions/createPr.ts:24-61
```

## The problem

Engineering knowledge lives in code, but questions get asked in Slack. The gap
gets filled by interrupting whoever wrote the code, spelunking through repos, or
trusting an LLM that has never seen your codebase and invents plausible
nonsense. Generic AI assistants can't cite your code; code search can't answer
questions.

**Beacon runs the dev loop between GitHub and Slack.** It indexes your repos
into a semantic + lexical + call-graph index, then works the whole cycle from
the thread: cited answers, PR reviews, fix PRs, and CI-failure triage — every
action grounded **only in retrieved evidence**.

## Why it's different

- **Grounded or silent.** Every answer is built from retrieved code and cited
  `repo/path:lines`. No evidence, no answer — it abstains instead of guessing.
- **It traces "why," not just "what."** An agentic planner inspects the first
  round of results and runs follow-up tools — search, read file, walk callers
  and callees over the code graph — before answering multi-hop questions.
- **Lives where the work happens.** Channels, DMs, and the Slack assistant pane.
  Answers stream in token-by-token and use thread history to resolve follow-ups.
- **Zero servers to babysit.** Two Cloudflare Workers plus a GitHub Actions
  indexing pipeline. Nothing to keep warm, nothing to operate.

## What it does

- **Grounded Q&A** — `/ask-code <question>` or `@bot <question>`. Answers stream
  with a `Sources` list and abstain when the evidence isn't there.
- **Agentic retrieval** — a planner LLM runs follow-up search / read / graph
  tools when the first pass is missing something. Time-budgeted, with graceful
  fallback to single-shot retrieval.
- **Hybrid search** — BM25 full-text (SQLite FTS5) + vector similarity
  (Vectorize + `embeddinggemma-300m`) + one-hop expansion over `CALLS` /
  `IMPORTS` edges, merged and reranked with symbol and diversity heuristics.
- **PR review** — paste a PR URL (or react with an emoji) and get a streamed
  review informed by the indexed codebase.
- **PR creation** — describe an issue in a thread, react with :rocket:, and the
  bot proposes file edits and opens a pull request.
- **CI-failure triage** — when a GitHub Actions run fails on an indexed repo,
  Beacon posts a *cited diagnosis* to the repo's Slack channel — grounded in the
  failing logs and the head commit's diff — and a :rocket: reaction opens a fix
  PR. Transient/infra flakes (timeouts, rate limits, OOM) get a re-run nudge
  instead of a false alarm.
- **Self-serve indexing** — `@bot index owner/repo` onboards a repo from Slack;
  `index status` shows live progress per repo.
- **Fully automatic indexing** — install the companion GitHub App and every push
  to the default branch incrementally reindexes only the changed files. No
  commands, no servers.

## How it works

```
 Slack ──/ask-code · @mention · DM · emoji──▶ slack-bot (CF Worker)
                                              │  verify → route → hybrid +
                                              │  agentic retrieval → reranked
                                              │  LLM answer, streamed + cited
                                              ▼
                       D1 (FTS5 + graph) · Vectorize (768d vectors)
                                              ▲
 GitHub App ──push──▶ github-webhook (CF Worker) ──▶ GitHub Actions indexer
                       (tree-sitter chunking → secret redaction → embed → upsert)
```

**Stack:** npm-workspaces TypeScript monorepo · Cloudflare Workers, D1
(SQLite + FTS5), Vectorize, Queues, Workers AI · GitHub Actions for indexing.
Full walkthrough in [docs/architecture.md](docs/architecture.md).

## Licensing

Beacon is proprietary software. This repository is not open source, and no
permission is granted to use, copy, modify, distribute, sublicense, or sell the
source code except under a separate written agreement with the copyright
holder. See [LICENSE](LICENSE).

## Get started

→ **[Set it up](docs/setup.md)** · **[Use it](docs/usage.md)** ·
**[Read the architecture](docs/architecture.md)**
