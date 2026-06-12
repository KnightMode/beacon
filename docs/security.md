# Security model

- **Signature verification** — Slack and GitHub signatures are verified on
  every request.
- **Prompt-injection resistance** — retrieved code is treated strictly as
  untrusted data in prompts, never as instructions.
- **Secret redaction** — chunks with obvious credentials are redacted before
  embedding.

## Prototype auth

One PAT does the indexing, and all Slack users can query everything on the
allowlist. This is the deliberate boundary for a prototype.

The extension points for real, per-user access control are already in place:

- the `users` and `github_user_repo_permissions` tables, and
- the per-repo retrieval filter.

Wiring per-user GitHub OAuth into these gives you permission-aware retrieval
where each Slack user only sees the repos they can actually access.
