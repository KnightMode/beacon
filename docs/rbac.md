# RBAC: roles and repo access (multi-tenant design)

Who can do what inside a tenant — especially around the sensitive actions:
indexing repos, creating PRs, and seeing code in answers.

## Principles

1. **Reading answers is cheap to grant, writing code is not.** Asking
   questions is open by default; indexing repos and creating PRs are
   restricted.
2. **GitHub stays the source of truth for code access.** We never grant
   anyone visibility into a repo that GitHub itself wouldn't show them (in
   strict mode), and we can never read a repo the tenant didn't grant the
   GitHub App.
3. **Tenant isolation is below RBAC, not part of it.** Roles control access
   *within* a tenant. Cross-tenant access is impossible by construction —
   each tenant has its own database and vector namespace, and the tenant is
   chosen by the signed Slack `team_id`, never by a role check.

## Roles

Three roles, stored per Slack user in the tenant's control-plane records:

| Role | Who gets it | Typical count |
|---|---|---|
| **Owner** | The person who installed the app (automatic) | 1–2 |
| **Admin** | Promoted by an owner | a few |
| **Member** | Everyone else in the workspace (automatic, no setup) | everyone |

Role management happens in Slack: `@beacon admins add @priya`,
`@beacon admins remove @priya`, `@beacon admins list`. Only owners can add or
remove admins; owners can transfer ownership.

## Permission matrix

| Action | Member | Admin | Owner |
|---|---|---|---|
| Ask questions (`/ask-code`, `@beacon`) | yes | yes | yes |
| PR review (paste URL / emoji) | yes | yes | yes |
| Index a new repo | no | yes | yes |
| Remove a repo from the index | no | yes | yes |
| Create fix PRs (`:rocket:`) | configurable (default yes) | yes | yes |
| Set CI-alert channels | no | yes | yes |
| Connect / reconnect GitHub | no | no | yes |
| Toggle strict mode (per-user repo permissions) | no | no | yes |
| Billing: upgrade, portal, cancel | no | no | yes |
| Manage admins | no | no | yes |

"Configurable" rows are tenant settings an owner can flip
(`@beacon settings`), because teams differ on how freely fix-PRs should be
created.

## Which repos can a user *query*? (the important one)

Two modes per tenant:

### Open mode (default)

Everyone in the Slack workspace can query every repo the tenant indexed.
Simple and right for most teams: if you're in the company Slack, you can ask
about the company code. The retrieval filter is just "repos in this tenant's
database" — cross-tenant leakage is structurally impossible.

### Strict mode (opt-in)

For tenants with private/sensitive repos that only some employees may see:

1. Each user links their GitHub account once (`@beacon link github`).
2. We sync each linked user's actual GitHub read permissions into
   `github_user_repo_permissions` (refreshed periodically and on demand).
3. Every retrieval — lexical, vector, and graph expansion — filters to repos
   that user can read. The vector query and SQL both take the same allowed
   repo-id list, so there is one filter applied consistently everywhere.
4. Answers, citations, and CI-triage posts respect the same filter. If a
   user can't read repo X, they never see a snippet of repo X, even in a
   shared channel thread started by someone who can.

Unlinked users in strict mode can still use the bot, but only against repos
marked "public to the workspace" by an admin.

## Where checks are enforced

One place, early: a `requireRole(tenant, userId, action)` check at the top of
each action handler (`actions/indexRepo.ts`, `actions/createPr.ts`, etc.),
plus the repo filter inside the retrieval pipeline. Denials reply in Slack
with who *can* do the action: *"Indexing new repos needs an admin — that's
@meera or @arjun."*

## Audit trail

Every privileged action (index, remove, settings change, role change, PR
created) writes an `audit_log` row in the tenant's own database: who, what,
when. Owners can pull the recent log with `@beacon audit`. This doubles as
the evidence trail for the emergency procedures in
`docs/emergency-handling.md`.
