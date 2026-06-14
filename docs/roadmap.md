# Roadmap to world-class

Foundations are in place; these are the highest-leverage next steps, roughly in
order.

1. **Eval harness** — ✅ shipped (`packages/eval`): a 24-case golden set with
   expected citations scored against the deployed worker via `POST /eval/ask`
   (citation P/R/F1 + groundedness + regex checks; offline dataset validation +
   preflight; manual `Eval` workflow in CI). Next: grow the golden set from real
   usage and add an LLM-judge.
2. **Tenant onboarding/admin portal** — ✅ shipped for the setup path: existing
   Pages app, Slack OAuth, GitHub App connection, repo picker, indexing status,
   channel mapping, mock local verification, and Cloudflare Access protection.
   Next: expand into billing, usage, people/roles, audit log, and settings.
3. **Shared runtime boundaries** — ✅ shipped for core duplication: shared repo
   parsing/IDs, encoding, AES-GCM secret crypto, GitHub dispatch helpers, Slack
   client wrappers, Octokit GitHub App auth, and indexer Cloudflare REST client
   plumbing. Next: keep new cross-runtime primitives in `packages/shared`.
4. **Feedback loop** — capture :+1:/:-1: on answers into D1 to grow the eval set
   from real usage and surface bad-answer patterns.
5. **Structural tenant isolation** — move from tenant-scoped rows in shared D1
   to per-tenant D1 databases plus Vectorize namespaces before broad SaaS
   rollout.
6. **Cross-encoder reranking** — a real reranker over the top ~50 candidates
   before context packing; the highest ROI-per-line change left in retrieval.
7. **Frontier answer model** — route the final answer (and the agent planner) to
   a stronger model; retrieval quality is increasingly ahead of the 8–30B-class
   models summarizing it.
8. **Permission-aware retrieval** — per-user GitHub OAuth + permission sync so
   each Slack user only sees repos they can access (schema already supports it).
9. **Index the conversation, not just the code** — PR descriptions, review
   threads, and issues hold the "why" that code can't express.
10. **Deeper code graph** — cross-file/cross-repo symbol resolution and multi-hop
   traversal to power richer agent tools.
11. **Observability** — log query → retrieved chunks → answer with stage
   latencies (Workers Analytics Engine) for debugging and eval mining.
12. **Code-tuned embeddings** — swap in a code-specialized model if the eval
   harness shows retrieval misses (requires reindex; measure first).
13. **Multi-branch & monorepo awareness** — index non-default branches and scope
    queries by path or service.
