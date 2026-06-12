# Development

```bash
npm run typecheck      # all workspaces
npm test               # vitest: signatures, chunking, filters, retrieval, intents
npm run dry-run        # wrangler deploy --dry-run for both workers
```

## Answer-quality eval

Beacon ships a golden-set eval harness (`packages/eval`) that turns every
retrieval or prompt change into a number instead of vibes. It scores end-to-end
answer quality against a 24-case golden set with expected citations —
citation precision/recall/F1, groundedness, and regex checks — by hitting the
deployed worker's `POST /eval/ask` route.

```bash
# Answer-quality eval against the deployed worker
EVAL_ENDPOINT=https://... EVAL_TOKEN=... npm run eval --workspace packages/eval
```

Full details — scoring weights, first-run calibration, growing the golden set,
and the manual `Eval` CI workflow — live in
[`packages/eval/README.md`](../packages/eval/README.md).
