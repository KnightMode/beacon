# Contributing to Beacon

Thanks for your interest in Beacon. This guide covers how to get a local
environment running, the checks we expect on every change, and how to propose
changes.

Beacon is an npm-workspaces TypeScript monorepo that runs on Cloudflare Workers,
Pages Functions, D1, Vectorize, Queues, and Workers AI, with a Node-based
indexer that runs on GitHub Actions. You do **not** need a full cloud
deployment to contribute — most work can be done and verified locally.

## Ways to contribute

- **Report a bug** — open a [Bug report](https://github.com/KnightMode/beacon/issues/new?template=bug_report.yml).
- **Request a feature** — open a [Feature request](https://github.com/KnightMode/beacon/issues/new?template=feature_request.yml).
- **Report a security issue** — do **not** open a public issue. Follow
  [SECURITY.md](SECURITY.md).
- **Send a pull request** — see [Pull requests](#pull-requests) below.

## Prerequisites

- Node ≥ 20 (`engines.node` in `package.json`)
- npm (workspaces are used; no extra package manager needed)
- A Cloudflare account is only required to deploy or to run against real
  Vectorize/Workers AI. Local schema, unit tests, and the admin-portal smoke
  test do not need one.

## Getting started

```bash
git clone https://github.com/KnightMode/beacon.git
cd beacon
npm install
npm run typecheck
npm test
```

That clone → install → typecheck → test loop is the minimum to confirm a healthy
checkout. Nothing here talks to a real account.

### Run the admin portal locally

The admin/onboarding portal runs as a Cloudflare Pages app (static `site/` +
Pages Functions in `functions/`), backed by a local D1 database:

```bash
cp site/.dev.vars.example .dev.vars   # local-only; gitignored, never commit it
npm run db:local:init                 # applies schema.sql + safe migrations to local D1
npm run dev:portal                    # serves the portal on http://127.0.0.1:8788
```

In another terminal, smoke-test the running portal:

```bash
npm run verify:local
```

As a quick manual check, `GET /api/admin/session` should return
`{"authenticated":false}` and `GET /api/admin/github/repos` should return `401`
until Slack is connected. See [docs/development.md](docs/development.md) and
[docs/local-verification.md](docs/local-verification.md) for the full local
workflow, and [docs/setup.md](docs/setup.md) for a real deployment.

## Project layout

| Path | What lives here |
| --- | --- |
| `workers/slack-bot` | Slack commands/events, streaming answers, retrieval, PR review, create-PR, CI triage |
| `workers/github-webhook` | GitHub App webhooks, queue dispatch, install/grant tracking |
| `functions/` + `site/` | Pages Functions API + admin onboarding portal |
| `services/indexer` | Node indexer: tree fetch, tree-sitter chunking, redaction, embed, D1/Vectorize writes |
| `containers/zoekt-search` | Zoekt query container used by the Slack worker |
| `packages/shared` | D1 schema, migrations, types, GitHub App + secret-crypto helpers |
| `packages/eval` | Golden-set answer-quality eval harness |

Cross-runtime logic belongs in `packages/shared`, not copied into individual
Workers or Functions.

## Required checks before you push

Run these locally; CI runs the same checks on `main`:

```bash
npm run typecheck     # TypeScript across all workspaces
npm test              # functions + workspace Vitest suites
npm run build         # workspace builds
npm run dry-run       # wrangler deploy --dry-run for both workers
git diff --check      # whitespace sanity
```

Please add or update tests for any behavior change. Retrieval and prompt changes
should keep the eval harness in mind — see
[docs/development.md](docs/development.md#answer-quality-eval).

## Pull requests

1. Fork the repo and create a topic branch from `main`
   (e.g. `fix/followup-repo-scope`).
2. Keep PRs focused. One logical change per PR is much easier to review.
3. Make sure the [required checks](#required-checks-before-you-push) pass.
4. Write a clear PR description: what changed, why, and how you verified it. Link
   any related issue.
5. By contributing, you agree your work is licensed under the project's
   [MIT License](LICENSE).

We use short, imperative commit subjects (e.g. "Improve Zoekt query recall").
Don't worry about squashing — maintainers will handle merge strategy.

## Handling secrets

Never commit real credentials. `.env`, `.env.*` (except `.env.example`),
`.dev.vars`, and `*.private-key.pem` are gitignored — keep it that way. Use the
`*.example` files as templates. If you ever suspect a secret was committed, stop
and follow [SECURITY.md](SECURITY.md).

## Questions

Open a [discussion or issue](https://github.com/KnightMode/beacon/issues). We're
happy to help you find a good first contribution.
