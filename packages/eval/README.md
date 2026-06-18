# @scintel/eval — golden-set eval harness

Measures end-to-end answer quality (retrieval + LLM) against a golden set of
questions with expected citations. Every retrieval or prompt change becomes a
number instead of vibes — and the composite score is the metric an
autoresearch-style agent loop can optimize against.

## How it works

```
golden/*.json ──> src/run.ts ──POST /eval/ask──> slack-bot worker (real D1/Vectorize/AI)
                      │                                   │
                      └──── src/score.ts <── answer + citations + timings
```

- The slack-bot worker exposes `POST /eval/ask` (Bearer `EVAL_TOKEN`; the
  route is 404 when the secret is unset). It runs the production
  `retrieveSmart` → `generateAnswer` path and returns the raw artifacts.
- The runner scores each case and writes a JSON report to `results/`.

## Scoring

Per case (`src/score.ts` — treat it as locked, like autoresearch's
`prepare.py`):

| Component | Weight | Meaning |
|---|---|---|
| Citation F1 | 0.5 | file-level precision/recall of citations the answer actually used vs `expectedFiles` |
| answerMust | 0.3 | fraction of required regexes matching the answer |
| Groundedness | 0.2 | fraction of `[n]` markers that map to a real citation |
| Source recall | 0.2 | optional recall over `expectedCitationSources` such as `zoekt` or `scip` |

Weights renormalize over the parts a case defines. Any `answerMustNot` match
zeroes the case. Negative cases (`expectNoAnswer`) score 1 iff the answer
cites nothing. The headline number is the mean composite across cases.

## Setup (one-time)

```bash
# 1. Enable the endpoint on the deployed worker
cd workers/slack-bot
wrangler secret put EVAL_TOKEN        # any long random string
npm run deploy

# 2. Point the harness at it
export EVAL_ENDPOINT=https://scintel-slack-bot.<account>.workers.dev
export EVAL_TOKEN=<same token>
```

The golden set assumes this repository itself is indexed (`index owner/repo`
from Slack, or the admin endpoint).

## Running

```bash
npm run validate --workspace packages/eval                    # lint the dataset offline (no network)
npm run eval --workspace packages/eval                        # default golden/beacon.json
npm run eval --workspace packages/eval -- --agentic false     # single-shot retrieval
npm run eval --workspace packages/eval -- --fail-under 0.6    # CI-style gate
npm run eval --workspace packages/eval -- --update-baseline   # pin current run as baseline
npm run eval --workspace packages/eval -- --skip-preflight    # skip the reachability check
```

Before any LLM calls the runner runs a **preflight**: it validates the dataset
(duplicate ids, bad regexes, contradictory cases) and sends one request to
confirm the endpoint is reachable, the token is accepted, and at least one repo
is indexed. Common failures it reports clearly: a `404` means `EVAL_TOKEN`
isn't set on the worker, a `401` means the token doesn't match, and an empty
allowlist means nothing is indexed yet.

Reports land in `results/latest.json` (plus a timestamped copy); the runner
prints the delta vs `results/baseline.json` when one exists. Per-case JSON also
includes citation source counts (`lexical`, `vector`, `graph`, `zoekt`, `scip`)
so retrieval-stage changes can be debugged without reading Worker logs.
`results/` is gitignored except `baseline.json`, so local runs stay local.

In CI, the `Eval` workflow (`.github/workflows/eval.yml`) is **manual**
(`workflow_dispatch` — Actions tab → Eval → "Run workflow") and uses the
`EVAL_ENDPOINT` / `EVAL_TOKEN` repo secrets. It uploads the whole `results/`
directory as a downloadable artifact named `eval-report-<run-number>` (30-day
retention), available from the run's Summary → Artifacts section. The artifact
is uploaded even when `--fail-under` fails the run, so you can always inspect
the scores.

## First-run calibration

The golden set (34 cases) is an answer key written from reading the code, so
the **first run measures the answer key as much as the bot**. When a case
scores low, check whether the bot was actually wrong or the case was too
strict before "fixing" retrieval:

- **Citation precision** drops when a good answer cites correct files that
  aren't in `expectedFiles`. List a question's genuinely-central files (1–2 is
  usually right); over-listing hurts recall instead. Path matching is
  suffix-tolerant, so `src/pack.ts` matches the full repo path.
- **answerMust** regexes can be too rigid — loosen with alternation
  (`budget|limit|cap`) rather than demanding exact wording.
- A wrong-looking abstain on a positive case usually means the repo isn't
  indexed or the question doesn't match indexed code.

Re-baseline (`--update-baseline`) only once the scores reflect real quality.

## Growing the golden set

Add cases to `golden/beacon.json` (or new files, selected via `--dataset`):

```jsonc
{
  "id": "unique-id",
  "question": "Where are Slack request signatures verified?",
  "expectedFiles": [{ "path": "workers/slack-bot/src/signature.ts" }], // suffix-tolerant
  "expectedCitationSources": ["zoekt"], // optional: require cited markers from these backends
  "answerMust": ["hmac|sha-?256"],     // case-insensitive regexes
  "answerMustNot": ["kubectl"],        // hard fail if matched
  "expectNoAnswer": false               // true for abstain cases
}
```

Good sources: real questions asked in Slack (especially ones that got a
:-1:), each paired with the files a correct answer must cite. Keep a few
`expectNoAnswer` cases so abstention regressions are caught too.
