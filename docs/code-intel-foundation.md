# Zoekt + SCIP Code-Intel Foundation

Beacon's original index is chunk/vector first: tree-sitter chunks, D1 FTS,
Vectorize embeddings, and a shallow `IMPORTS` / `CALLS` graph. That remains the
fallback path, but production-scale cross-repo reasoning needs two stronger
substrates:

- **Zoekt** for exact source-code search across many repos.
- **SCIP** for language-aware symbols, definitions, references, implementations,
  and overrides.

## Runtime Split

Heavy indexing stays in GitHub Actions to avoid paying Cloudflare Container CPU
for long repo indexing jobs.

```
GitHub App push/install
  -> Index Repository workflow
     -> current chunk/embed indexer
     -> zoekt-index artifact generation
     -> configured SCIP indexer commands
     -> SCIP-compatible fallback facts from chunks/code_edges
     -> normalized SCIP facts into D1
     -> Zoekt shard files to R2
     -> artifact manifest rows in D1

Slack query
  -> slack-bot Worker
     -> tenant repo allowlist
     -> Zoekt Container search through service binding
     -> SCIP symbol/xref tables
     -> Vectorize semantic retrieval
     -> D1 FTS/code_edges fallback
     -> rerank + cited answer
```

Cloudflare Containers serve Zoekt at query time only. The container endpoint is
the low-latency search surface; it is not the default heavy indexing runner.
The deploy workflow provisions the R2 bucket, deploys the container Worker, and
binds the Slack worker to it.

## Data Model

`code_index_artifacts` records the produced repo/commit artifacts:

- `ZOEKT_SHARD`
- `SCIP_INDEX`
- `SCIP_SYMBOLS`

`scip_symbols` and `scip_references` store normalized facts beside the existing
`code_edges` table. The old table remains useful as a cheap fallback and for
repos that have not been backfilled.

`staged_pr_plans` and `staged_pr_steps` model large or breaking changes as a
validated sequence instead of one unbounded diff.

## Configuration

Indexer/GitHub Actions:

```text
CODE_INTEL_MODE=off|best_effort|required
CODE_INTEL_ARTIFACT_BASE_URI=r2://beacon-code-intel/zoekt
ZOEKT_INDEX_BIN=zoekt-index
ZOEKT_INDEX_DIR=/path/to/index
SCIP_COMMANDS_JSON=[{"name":"scip-typescript","language":"typescript","command":"scip-typescript","args":["index","--infer-tsconfig"],"output":"index.scip"}]
SCIP_FACTS_PATH=scip-facts.json
BEACON_CODE_INTEL_BUCKET=beacon-code-intel
BEACON_ZOEKT_R2_PREFIX=zoekt
```

GitHub Actions defaults `BEACON_CODE_INTEL_MODE` to `best_effort` so full
indexing produces Zoekt/SCIP artifacts by default. Set the repository variable
to `off` only as a speed/emergency lever; use `required` when artifact
generation failures should fail indexing.

Slack worker:

```text
ZOEKT_SEARCH service binding -> beacon-zoekt-search
ZOEKT_SEARCH_TOKEN=<secret or INDEXER_SHARED_SECRET fallback>
```

Zoekt container secrets:

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
ZOEKT_SEARCH_TOKEN              # optional; falls back to INDEXER_SHARED_SECRET in CI
```

## SCIP Fact Import Contract

Beacon ingests normalized facts from `SCIP_FACTS_PATH`:

```json
{
  "symbols": [
    {
      "id": "stable-symbol-id",
      "symbol": "scip symbol",
      "displayName": "OrderService.create",
      "kind": "method",
      "language": "java",
      "path": "src/main/java/OrderService.java",
      "startLine": 42,
      "endLine": 58,
      "definitionChunkId": "optional-chunk-id"
    }
  ],
  "references": [
    {
      "symbolId": "stable-symbol-id",
      "role": "reference",
      "path": "src/main/java/CheckoutController.java",
      "startLine": 91,
      "endLine": 91,
      "enclosingSymbol": "CheckoutController.checkout"
    }
  ]
}
```

SCIP indexers emit `index.scip`; a production normalizer can convert that file
into this compact JSON shape before the Beacon indexer finishes. If no
normalizer output exists, Beacon builds SCIP-compatible symbol/reference facts
from semantic chunks and `code_edges`, so retrieval is active immediately after
indexing.

## Retrieval Order

The retrieval candidate pool now combines:

1. SCIP definitions/references.
2. Zoekt exact search hits.
3. Vectorize semantic hits.
4. D1 FTS hits.
5. Existing `code_edges` graph expansion.

Zoekt and SCIP are additive. If the endpoint or tables are unavailable, Beacon
logs the failure and continues with the existing retrieval path.

## Staged PR Rule

For small changes, Beacon can still open one PR after generating edits.

For large, breaking, dependency, schema, API, or cross-repo changes, Beacon
creates a staged migration plan:

1. Add a backward-compatible provider change.
2. Migrate one downstream consumer and validate it.
3. Migrate remaining consumers in dependency order.
4. Remove deprecated compatibility only after references are gone.

This keeps automation useful without letting the bot create one huge,
unreviewable cross-repo diff.
