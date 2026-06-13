# Emergency handling (multi-tenant design)

What can go wrong, how we notice, and exactly what we do about it. Written as
a runbook: each scenario has a detection method and a response, in order.

## The tools we keep ready (build these before we need them)

| Tool | What it does |
|---|---|
| **Tenant kill switch** | `status = 'suspended'` on a tenant row. Every entry point checks it first; a suspended tenant gets a polite "temporarily paused" reply and no work runs. Takes effect in seconds. |
| **Global kill switch** | A single flag (Workers KV) that pauses expensive paths product-wide: new index jobs, agentic retrieval, fix-PR creation. Q&A can keep running in cheap non-agentic mode. |
| **Dead-letter queues** | Already configured for every queue. Failed jobs land here instead of disappearing, and can be replayed after a fix. |
| **Audit log** | Per-tenant record of privileged actions (see `docs/rbac.md`) — the first thing we read in any incident. |
| **Alerting** | Error-rate and queue-depth alerts from Workers analytics into our own Slack ops channel. |

## Scenario 1: A secret leaks (bot token, GitHub App key, API token)

The most serious case. Order matters: revoke first, investigate second.

1. **Revoke at the source.** Slack token → revoke via Slack API; GitHub App
   key → generate a new key and delete the old one in GitHub settings;
   Cloudflare API token → roll it in the dashboard.
2. **Rotate our side.** `wrangler secret put` the replacements; for
   per-tenant Slack tokens, the affected workspaces just re-install (we DM
   the owner a one-click re-auth link).
3. **Check the blast radius.** Slack tokens are encrypted at rest, so a
   control-DB leak alone does not expose them — the encryption key (a Worker
   secret) would also have to leak. GitHub access tokens are short-lived
   (~1h) and never stored, so they expire on their own.
4. **Tell affected customers** what leaked, what it could access, and what we
   did. Honestly and quickly.

## Scenario 2: Suspected cross-tenant data leak

This is the nightmare scenario the architecture is designed to prevent: each
tenant has its **own database** and its **own vector namespace**, and the
tenant is selected from the cryptographically signed Slack request. A bug
would have to pass the wrong database id or namespace through the whole
pipeline.

If it's ever suspected anyway:

1. Flip the **global kill switch** for answers (minutes of downtime beats
   confirmed leakage).
2. Reproduce: find the answer/citation that crossed tenants, pull the request
   log (tenant id, database id, namespace used at each retrieval stage).
3. Fix, add a regression test that asserts tenant context survives every
   queue hop, re-enable.
4. Disclose to the affected tenants. Their audit log plus our request logs
   tell us exactly which questions saw which data.

## Scenario 3: Provisioning fails mid-way (new customer stuck)

Setup is a queue job with retries, and every step is idempotent (create-if-
missing database, `CREATE TABLE IF NOT EXISTS` migrations), so most failures
heal themselves on retry.

- Job exhausts retries → lands in the DLQ → alert fires.
- Tenant stays in `provisioning`; the customer sees "still setting up" rather
  than errors.
- We fix the cause (commonly: Cloudflare API hiccup or account limit) and
  replay the DLQ job. The customer never has to re-install.
- If a tenant is stuck > 15 minutes, the bot proactively DMs the installer:
  "Setup is taking longer than usual — we're on it." Nobody refreshes a
  silent screen.

## Scenario 4: Queue backlog / indexing storm

A big org connects GitHub and pushes to 200 repos at once, or a webhook loop
floods the index queue.

- **Per-tenant concurrency cap** (one full index at a time per tenant) means
  one tenant cannot starve the others — this is the main defense.
- Queue-depth alert fires → check whether it's one tenant (their jobs are
  tagged) → if one tenant is misbehaving, suspend just their indexing, talk
  to them, drain.
- If it's everyone (e.g. a bad deploy made jobs fail-and-retry), pause queue
  consumption, fix, resume; the queue itself is the buffer, nothing is lost.

## Scenario 5: Runaway AI cost

A tenant scripts thousands of questions, or an agentic-retrieval bug loops on
tool calls.

- Hard caps per answer (max planner steps, max tokens) bound the worst case
  of any single question.
- Per-tenant daily usage is already metered for billing — the same numbers
  feed a cost alert ("tenant X used 10× its plan today").
- Response ladder: rate-limit the tenant → suspend the tenant → global
  switch to cheap non-agentic answers. Each step is one flag.

## Scenario 6: Upstream outage (Cloudflare AI, GitHub, Slack)

We sit on three providers; any of them can have a bad hour.

- **Workers AI down:** answers fail fast with "having trouble thinking right
  now, try again shortly" — never hang, never half-answer. Index jobs retry
  later via the queue.
- **GitHub down:** Q&A over already-indexed code **keeps working** (the index
  is ours). Only fresh indexing and PR actions pause; jobs queue up and drain
  when GitHub recovers.
- **Slack down:** nothing to do — no requests arrive. Queued work continues;
  results that fail to post retry through the queue.

## Scenario 7: A customer demands deletion / offboards (GDPR-style)

Per-tenant databases make this clean:

1. Suspend the tenant (stops new writes).
2. Delete their D1 database (one API call), delete their vector namespace,
   delete their control-plane rows and Stripe customer.
3. Confirm to the customer. There is no "their rows are mixed into a shared
   table" problem to untangle — deletion is structural.

The same applies when a workspace uninstalls the Slack app: Slack sends an
`app_uninstalled` event → we suspend immediately and start a 30-day deletion
timer (grace period in case the uninstall was accidental).

## Scenario 8: Bad deploy

- Workers deploy via CI; rollback is `wrangler rollback` (or redeploy the
  previous commit) — takes about a minute.
- Schema migrations for tenant databases roll out gradually (tenant by
  tenant, tracked by `schema_version`), so a bad migration is caught on the
  first tenants, paused, and fixed before it touches the rest. Migrations
  are additive (new tables/columns) wherever possible so old code keeps
  working against new schema during rollout.

## After every incident

A short written post-mortem: what happened, how we noticed, how long it took,
what we changed so it can't repeat. Filed in the repo, linked from this doc.
