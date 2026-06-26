# Development

```bash
npm run typecheck      # TypeScript across all workspaces
npm test               # functions + workspace Vitest suites
npm run build          # workspace builds
npm run dry-run        # wrangler deploy --dry-run for both workers
git diff --check       # whitespace sanity before review
```

## Local Pages/admin smoke test

The admin portal runs as a Cloudflare Pages app: static assets from `site/` and
Pages Functions from the repo-root `functions/` directory.

```bash
cp site/.dev.vars.example .dev.vars
npm run db:local:init
npm run dev:portal
```

`db:local:init` applies the full schema plus the safe admin/code-intel migration
runner, so local Pages state matches the deployed admin/control-plane shape.

In another terminal:

```bash
npm run verify:local
```

For a quick unauthenticated runtime check, `GET /api/admin/session` should
return `{"authenticated":false}` and `GET /api/admin/github/repos` should
return `401` until Slack is connected. If the default port is busy, run
`wrangler pages dev site --port 8791 --persist-to .wrangler/state` and set
`BASE_URL=http://127.0.0.1:8791` for verification.

## Shared runtime utilities

Cross-runtime logic belongs in `packages/shared`, not copied into individual
Workers or Pages Functions. Current shared utility boundaries include repo
parsing/IDs, encoding, AES-GCM secret encryption/decryption, and GitHub
`repository_dispatch` request plumbing.

Domain-specific clients should remain local to their owning runtime when they
encode workflow behavior, for example Slack streaming in `workers/slack-bot`
or PR/review GitHub operations in `workers/slack-bot/src/github.ts`.

## Answer-quality eval

Beacon ships a golden-set eval harness (`packages/eval`) that turns every
retrieval or prompt change into a number instead of vibes. It scores end-to-end
answer quality against a 28-case golden set with expected citations —
citation precision/recall/F1, groundedness, and regex checks — by hitting the
deployed worker's `POST /eval/ask` route.

```bash
# Answer-quality eval against the deployed worker
EVAL_ENDPOINT=https://... EVAL_TOKEN=... npm run eval --workspace packages/eval
```

Full details — scoring weights, first-run calibration, growing the golden set,
and the manual `Eval` CI workflow — live in
[`packages/eval/README.md`](../packages/eval/README.md).
