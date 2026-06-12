# Usage

Everything happens in Slack — in channels, DMs, or the assistant pane.

| In Slack | What happens |
|---|---|
| `@bot <question>` / `/ask-code <q>` | streamed, cited answer from the index |
| `@bot index owner/repo` | validate, allowlist, and full-index a repo |
| `@bot index status` | live indexing progress for every repo |
| `review <pr-url>` (or emoji on a PR link) | streamed PR review |
| `create pr: <issue>` (or :rocket: on a thread) | LLM-proposed pull request |

Answers stream in token-by-token with a `Sources` list (`repo/path:lines`).
Thread history is used to resolve follow-ups, and if the evidence isn't there,
the bot says so instead of guessing.

## Triggering indexing manually

Besides `@bot index owner/repo` and automatic indexing via the GitHub App, you
can kick off an index run by:

- **Actions tab** — `Index Repository` → Run workflow
- **Admin endpoint** — `POST /admin/index` on the webhook worker
- **Locally** — `npm run index --workspace services/indexer -- owner/repo`
