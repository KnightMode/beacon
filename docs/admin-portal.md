# Admin portal (multi-tenant design)

A web dashboard where customers manage their account: see usage, manage
billing, repos, people, and settings. Everything an owner/admin needs from an
"account perspective", in one place.

The Slack commands (`@beacon admins add`, `@beacon billing`, …) stay — they
are the quick path. The portal is the complete path, and the only place for
anything that needs a real screen (usage charts, invoices, audit history).

## How customers get in: Sign in with Slack

No new passwords. The portal uses **Sign in with Slack** (OpenID Connect):

1. Customer visits `portal.<domain>` and clicks "Sign in with Slack".
2. Slack confirms who they are and which workspace they belong to.
3. We map workspace → tenant and user → role (owner / admin / member, same
   roles as `docs/rbac.md`), then set a short-lived signed session cookie.

So access to the portal is governed by exactly the same identity as the bot:
if you can't get into the company Slack, you can't get into the portal. No
separate user management, ever.

What each role sees:

| Page | Member | Admin | Owner |
|---|---|---|---|
| Overview + usage | view | view | view |
| Repos | view | manage | manage |
| People & roles | view | view | manage |
| Settings | view | manage | manage |
| Billing & invoices | — | view | manage |
| Audit log | — | view | view |
| Danger zone | — | — | manage |

## The pages

### 1. Overview

The "is everything okay?" page: current plan, usage this billing period shown
against plan limits (questions used / quota, repos indexed / quota), GitHub
connection status, and any warnings (over quota, payment failed, indexing
errors). One glance answers "are we fine".

### 2. Usage

The reason customers actually open the portal:

- Questions asked per day/month, with plan quota drawn on the chart.
- Indexing activity (repos indexed, incremental updates).
- Breakdown by Slack user — who's getting value (great ammo for whoever
  champions the tool internally).
- What the current period will cost if it ends today (base plan + metered
  overage), so the invoice is never a surprise.
- CSV export.

Data comes from the same `usage_events` table that feeds Stripe metering —
one source of truth, so the portal and the invoice always agree.

### 3. Repos

- Every indexed repo: status (indexed / indexing / failed), last index time,
  commit, size, language mix.
- Actions: trigger re-index, remove a repo, see why a repo failed.
- "Add repo" shows what the GitHub installation can see but isn't indexed
  yet — one click to index, quota permitting.

### 4. People & roles

- Everyone who has used the bot, with their role.
- Owners promote/demote admins here (same effect as the Slack command).
- In strict mode: who has linked GitHub, who hasn't, and a nudge button that
  DMs the unlinked.

### 5. Billing

- Current plan, renewal date, payment method, plan comparison with
  upgrade/downgrade (Stripe Checkout for upgrades).
- Invoice history (from Stripe).
- "Manage payment details" hands off to the Stripe Customer Portal — card
  data never touches our systems.

### 6. Settings

- Strict mode toggle (per-user repo permissions).
- Who may create fix-PRs (everyone vs admins).
- CI alert channel defaults.
- GitHub connection: which installation, which repos granted, reconnect.

### 7. Audit log

The per-tenant audit trail from `docs/rbac.md`, searchable and filterable:
who indexed what, who changed roles, who changed settings, when.

### 8. Danger zone (owners only)

- Disconnect GitHub.
- Pause the bot (tenant-level kill switch — useful during *their* incidents).
- Delete account and all data: types the workspace name to confirm, then runs
  the structural deletion from `docs/emergency-handling.md` (drop tenant
  database, vector namespace, control rows, Stripe customer). Email + DM
  confirmation when complete.

## How it's built

Same stack as everything else — no new infrastructure type:

```
portal/  (React SPA, static assets)
   served by →  workers/portal  (new Worker)
                  ├─ GET  /auth/slack, /auth/callback   Sign in with Slack (OIDC)
                  ├─ GET  /api/overview, /api/usage     reads control-plane D1
                  ├─ GET/POST /api/repos, /api/members, /api/settings
                  │       reads/writes tenant D1 (HTTP API) + enqueues jobs
                  └─ POST /api/billing/checkout, /api/billing/portal   Stripe
```

- **One new Worker** (`workers/portal`) serves both the static SPA and its
  JSON API. It binds the same `CONTROL_DB` and uses the same shared
  `TenantDb` client and Stripe helpers as the bot — the portal contains no
  logic of its own beyond screens.
- Every API route re-derives tenant and role from the session cookie and
  re-checks permissions server-side; the role table above is enforced in the
  API, not just hidden in the UI.
- Mutations (re-index, role change, setting change) go through the same code
  paths and queues as the Slack commands, and write the same audit log — two
  front doors, one set of rules.

## What stays out of scope (deliberately)

- No asking code questions from the portal — Slack is the product surface.
- No portal-only roles or separate logins — identity stays Slack-defined.
- No custom payment forms — Stripe owns all card handling.
