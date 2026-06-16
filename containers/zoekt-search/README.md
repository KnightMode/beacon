# Beacon Zoekt Search Container

Cloudflare Container wrapper for serving Zoekt search to the Slack worker.

The heavy indexing job still runs in GitHub Actions. This service is only the
low-latency query surface used by `ZOEKT_SEARCH_URL`.

## Contract

`POST /search`

```json
{
  "query": "createPullRequest",
  "repos": ["knightmode/beacon"],
  "limit": 20
}
```

The Worker enforces the bearer token, injects repo filters into Zoekt's query,
and forwards to the container's `/search?format=json` endpoint. In production
the Slack worker calls this Worker through a service binding named
`ZOEKT_SEARCH`, so no public URL discovery is needed.

## Deploy

```bash
cd containers/zoekt-search
npm install
wrangler secret put ZOEKT_SEARCH_TOKEN
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_BUCKET_NAME
wrangler secret put R2_BUCKET_PREFIX
npm run deploy
```

The deploy workflow syncs those secrets from GitHub Actions:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `ZOEKT_SEARCH_TOKEN` or `INDEXER_SHARED_SECRET`
- `CLOUDFLARE_ACCOUNT_ID`
- `BEACON_CODE_INTEL_BUCKET` / `BEACON_ZOEKT_R2_PREFIX` vars

Set the Slack worker secret if deploying manually:

```bash
cd workers/slack-bot
wrangler secret put ZOEKT_SEARCH_TOKEN
```

## Index Artifacts

The container syncs the configured R2 prefix into local disk with `rclone` and
serves that local directory with `zoekt-webserver`. Zoekt shards must live
directly under `${R2_BUCKET_PREFIX:-zoekt}` because Zoekt watches only the
configured index directory for `*.zoekt` files. The index workflow runs
`scripts/sync-zoekt-index-to-r2.mjs` after `zoekt-index` generates flat shard
files such as `knightmode_beacon_v16.00000.zoekt`.
