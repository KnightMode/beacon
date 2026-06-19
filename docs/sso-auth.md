# SSO and authentication (multi-tenant design)

Status: partially implemented. Slack OAuth currently powers the admin
onboarding session and tenant Slack install records. Strict per-user GitHub
permission mirroring is still future work.

Who is allowed to talk to Beacon, and how we know who they are. The short
version: **Slack is our SSO**. We never run our own passwords, signup forms,
or user database logins.

## The three identities

Every request involves up to three identities, each verified differently:

| Identity | Who it is | How we verify it |
|---|---|---|
| Workspace (tenant) | The Slack workspace / company | Slack OAuth install + request signature |
| Person | The individual Slack user asking | Slack tells us the `user_id` in every event |
| Code access | What GitHub repos the tenant/person can see | GitHub App install + (optional) per-user GitHub OAuth |

## Workspace auth: Slack OAuth v2

- Installing the app is the "signup". Slack's OAuth flow proves the installer
  is an authorized member of that workspace — we inherit Slack's own SSO,
  2FA, and admin approval policies for free.
- The bot token we receive is scoped to exactly one workspace. We encrypt it
  (AES-GCM, key held as a Worker/Pages secret) before storing it in D1.
  Decryption only happens in-memory while handling a request.
- Every incoming Slack request is verified with the signing secret (HMAC,
  already implemented in `workers/slack-bot/src/signature.ts`). A request
  that doesn't carry a valid signature never reaches any logic.
- The `team_id` in the verified payload selects the tenant. There is no way
  to ask a question "as" another workspace, because the tenant is derived
  from the signed request, never from user input.

## Person auth: Slack user identity

- Slack includes the `user_id` of the person behind every command, mention,
  and reaction. Since the request itself is signature-verified, we trust this
  identity — the user already authenticated to Slack (including whatever
  SSO/SAML their company enforces on Slack itself).
- This is the identity we use for: RBAC roles (see `docs/rbac.md`), audit
  logs, rate limiting per person, and the GitHub account link below.
- Consequence worth stating plainly: **if your company's IdP (Okta, Entra,
  Google) controls Slack access, it automatically controls Beacon access.**
  Offboard an employee from Slack and they're offboarded from Beacon. We do
  not need our own SAML integration for the in-Slack product.

## Code access auth: GitHub App (+ optional per-user OAuth)

Two levels, depending on how strict the tenant wants to be:

### Level 1 — workspace-level (default)

- The tenant installs our GitHub App and picks repos. Everyone in the Slack
  workspace can query everything the tenant has indexed.
- Current implementation: the admin repo picker, Slack-side GitHub reads/writes,
  and tenant indexing jobs use short-lived installation tokens minted from the
  App's private key when a Slack tenant and selected repo grant are present.
  `GITHUB_PAT` remains only for legacy local/non-tenant development paths and
  as an optional workflow-dispatch token.

### Level 2 — per-user mirroring (opt-in, "strict mode")

- For tenants where not every Slack member may see every repo: each user
  links their own GitHub account once (`@beacon link github` → GitHub OAuth →
  we store the association in the existing `users` table).
- We periodically sync which repos each linked user can actually read on
  GitHub into `github_user_repo_permissions` (table already exists in the
  schema).
- Retrieval then filters to the intersection of (tenant's indexed repos) and
  (repos this user can read). An unlinked user in strict mode gets a polite
  "link your GitHub first" message instead of answers.

## Service-to-service auth (internal)

- GitHub webhooks: HMAC signature with the webhook secret.
- Indexer HTTP endpoint: shared bearer secret, plus the job itself carries
  the tenant context so the indexer can only write to that tenant's database
  and namespace.
- Billing webhooks: future work; any Stripe integration must verify Stripe
  webhook signatures before updating tenant state.
- Admin portal: Cloudflare Access protects deployed admin paths; the Pages app
  also uses a signed short-lived `beacon_admin_session` cookie after Slack
  OAuth.
- Eval endpoints: bearer token.

## What we deliberately do NOT build

- No email/password accounts and no password resets. Slack and GitHub are the
  only login screens a customer sees, and both are screens they already trust.
- The current web admin onboarding surface already signs in through Slack OAuth
  and stores only a signed session cookie. Broader dashboard pages should keep
  that same identity model.
