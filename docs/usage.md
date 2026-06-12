# Usage

Everything happens in Slack — in channels, DMs, or the assistant pane.

| In Slack | What happens |
|---|---|
| `@bot <question>` / `/ask-code <q>` | streamed, cited answer from the index |
| `@bot index owner/repo` | validate, allowlist, and full-index a repo |
| `@bot index status` | live indexing progress for every repo |
| `review <pr-url>` (or emoji on a PR link) | streamed PR review |
| `create pr: <issue>` (or :rocket: on a thread) | LLM-proposed pull request |
| `@bot notify owner/repo here` | map a repo's CI-failure alerts to this channel |

Answers stream in token-by-token with a `Sources` list (`repo/path:lines`).
Thread history is used to resolve follow-ups, and if the evidence isn't there,
the bot says so instead of guessing.

## CI-failure triage

Once a repo's alerts are mapped to a channel (`@bot notify owner/repo here`),
Beacon watches GitHub Actions `workflow_run` events on that indexed repo. When a
run fails:

- It dedupes per run + attempt, fetches the failed jobs' logs, and posts a
  **cited diagnosis** to the mapped channel — grounded in the failing logs, the
  head commit's diff, and retrieval over the code index.
- React with :rocket: on the analysis to flow straight into the create-PR path
  and propose a fix.
- Deterministic gates run *before* any LLM call: transient/infra signatures
  (timeouts, rate limits, OOM, runner death) get a short re-run note instead of
  a full triage, and the indexing pipeline repo is excluded to prevent loops.

Requires the GitHub App to have **Actions: Read** and the **Workflow runs**
event subscription (and `Actions: Read` on the indexing PAT).

## Triggering indexing manually

Besides `@bot index owner/repo` and automatic indexing via the GitHub App, you
can kick off an index run by:

- **Actions tab** — `Index Repository` → Run workflow
- **Admin endpoint** — `POST /admin/index` on the webhook worker
- **Locally** — `npm run index --workspace services/indexer -- owner/repo`
