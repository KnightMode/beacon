# Onboarding flows (multi-tenant design)

How a new customer goes from "never heard of Beacon" to "asking questions about
their code in Slack". Each flow below is a separate step a customer walks
through, in order.

## The big picture

```
Add to Slack  →  workspace provisioned  →  connect GitHub  →  index a repo  →  ask questions
   (2 min)          (automatic, ~10s)         (1 min)           (minutes)        (forever)
```

A customer can stop at any step and come back later. The bot always knows what
step they're on and tells them what to do next.

## Flow 1: Add to Slack (creates the tenant)

1. Customer clicks **"Add to Slack"** on the marketing site (or a shared link).
2. Slack shows the standard permission screen. The customer (must be someone
   allowed to install apps in their workspace) clicks Allow.
3. Slack redirects to our `GET /slack/oauth/callback` with a temporary code.
   We exchange it for a bot token for *their* workspace.
4. We create a `tenants` row keyed by their Slack `team_id`, store the bot
   token (encrypted), and set status to `provisioning`.
5. A background job creates their private D1 database, applies the schema, and
   flips the tenant to `active`. This takes a few seconds.
6. The bot DMs the installer: *"You're all set up. Next step: connect GitHub
   so I can read your code."* with a button.

If the same workspace installs twice, we just refresh the token — no duplicate
tenant.

**What the customer sees:** click a button, click Allow, get a friendly DM.
They never see "provisioning".

## Flow 2: Connect GitHub (gives us read access to their code)

1. From the DM (or by typing `@beacon connect github`), the customer gets a
   link to install our **GitHub App** on their org or personal account.
2. The link carries a short-lived signed state token that says "this install
   belongs to Slack workspace T024ABC". This is how we tie the two accounts
   together safely — nobody can connect their GitHub to someone else's Slack.
3. On the GitHub side, the customer picks **which repos** the app can see
   (all repos, or a hand-picked list). This is GitHub's own screen — we never
   get more access than they grant.
4. GitHub sends us an `installation` webhook. We verify the state token, store
   the `installation_id` against the tenant, and DM the customer: *"GitHub
   connected. Say `@beacon index owner/repo` to index your first repo."*

From this point on, all GitHub access for this tenant uses short-lived
installation tokens (refreshed automatically) — no PATs anywhere.

## Flow 3: Index the first repo

1. Customer types `@beacon index owner/repo` in Slack.
2. We check: is the repo visible to their GitHub installation? Is it within
   their plan's repo limit and size limit? If not, we say so plainly and (for
   plan limits) offer an upgrade link.
3. We enqueue an index job carrying the tenant context (tenant id, their
   database id, their vector namespace).
4. The bot posts progress in the thread: *"Indexing owner/repo… 1,204 files,
   ~3 minutes."* and a final *"Done — ask me anything about owner/repo."*
5. After this, pushes to the repo trigger automatic incremental re-indexing
   through the GitHub App webhook.

## Flow 4: First question

Nothing to set up. `/ask-code how does auth work?` or `@beacon <question>`
works the moment the first repo finishes indexing. The first answer includes a
one-line tip about citations and the `:rocket:` fix-PR reaction.

## Flow 5: Billing (only when they hit a limit)

Customers start on the **Free plan** automatically — no card required.
Billing onboarding happens lazily:

1. When they hit a Free limit (e.g. question quota, second repo), the bot
   replies with what happened and a **Stripe Checkout** link.
2. After checkout, the Stripe webhook updates the tenant's plan immediately
   and the bot DMs a confirmation. No re-install, no downtime.
3. `@beacon billing` always returns a link to the Stripe customer portal
   (change plan, update card, see invoices).

## Resuming a half-finished setup

The bot infers the customer's state from the tenant row and answers any
message accordingly:

| State | Bot's reply to any question |
|---|---|
| Provisioning | "Still setting up your workspace — about a minute." |
| No GitHub install | "Connect GitHub first: <button>" |
| No repos indexed | "Index a repo first: `@beacon index owner/repo`" |
| Active | Answers normally |

This means there is no separate "wizard" to abandon — the product itself is
the wizard.
