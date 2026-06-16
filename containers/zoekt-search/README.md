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

The container mounts the configured R2 bucket read-only via `rclone` and serves
`${R2_BUCKET_PREFIX:-zoekt}` as the Zoekt index directory. The index workflow
runs `scripts/sync-zoekt-index-to-r2.mjs` after `zoekt-index` generates shard
files.
