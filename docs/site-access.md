# Protect the admin portal with Cloudflare Access

The marketing site deploys from `site/` to Cloudflare Pages as the `beacon`
project. The admin portal is the sensitive surface. Use the manual
`Configure site Access` GitHub Actions workflow to protect only the admin paths
with Cloudflare Access and allow login by email one-time PIN.

Cloudflare Access applications, the OTP identity provider, the Pages custom
domain, queues, and the shared D1 resource are Terraform-managed. Pages runtime
secret sync, D1 migrations, and the Pages deploy remain imperative. See
[Cloudflare Terraform](./cloudflare-terraform.md) for the ownership boundary and
first-time import steps.

## Required Cloudflare token permissions

The repository already uses `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` secrets for Pages deploys. The token used by the Access
workflow must also include:

- `Access: Apps and Policies Write`
- `Access: Organizations, Identity Providers, and Groups Write`
- `D1: Edit`
- `Queues: Edit`
- `Cloudflare Pages: Edit`

The workflow also syncs admin portal runtime config into Pages. Set these
GitHub Actions secrets before running it:

- `ADMIN_SESSION_SECRET`
- `SLACK_CLIENT_SECRET`
- `SLACK_TOKEN_ENCRYPTION_SECRET`

Optional secrets used by later onboarding steps:

- `BEACON_GITHUB_APP_PRIVATE_KEY` (written to Pages as `GITHUB_APP_PRIVATE_KEY`)
- `PIPELINE_DISPATCH_TOKEN` (used only to trigger the GitHub Actions indexer workflow)

Optional repository variables used by later onboarding steps:

- `BEACON_GITHUB_APP_SLUG` (defaults to `scintel-indexer`)
- `BEACON_GITHUB_APP_ID`

## Configure access

### GitHub Actions

After this workflow exists on GitHub, you can configure Access without exposing
Cloudflare credentials locally:

1. Open GitHub Actions.
2. Run `Configure site Access`.
3. Keep `site_hostname` as `askbeacon.dev`, unless you are protecting a
   different hostname on the Pages project.
4. Keep `protected_paths` as
   `/admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*`.
5. Keep `pages_project_name` as `beacon` and `pages_environment` as `production`,
   unless you are protecting another Pages project/environment.
6. Enter `slack_client_id`, or set the repository variable `SLACK_CLIENT_ID`.
7. Keep `d1_binding` as `DB` and `d1_database_name` as `scintel`, unless you
   created a different D1 database. The workflow reads the database id from
   Terraform output.
8. Keep `github_app_slug`, `pipeline_dispatch_repo`, and
   `pipeline_dispatch_event` unless those resources have different names.
9. Enter either `allowed_emails`, `allowed_domains`, or both.
10. Check `confirm_imported_state` only after the existing Cloudflare resources
    have been imported into Terraform state.

The workflow writes the generated `ADMIN_CF_ACCESS_*` runtime vars directly to
the Pages project, syncs the Slack/session admin runtime config from workflow
inputs and GitHub Actions secrets, applies the admin D1 tenant migrations, binds
the `DB` D1 database, then deploys the Pages site so the Functions runtime
receives those bindings. Terraform owns the Access apps and policies; the Pages
runtime sync only mirrors the Terraform issuer/audience outputs and secrets that
cannot be cleanly imported into Terraform today.

If `confirm_imported_state` is not checked, or if required resources are missing
from Terraform state, the workflow exits before `terraform apply`. This protects
the already-provisioned Cloudflare account from duplicate creation attempts.

Example values:

```text
allowed_emails: differentialcircuit@gmail.com
allowed_domains: example.com
site_hostname: askbeacon.dev
protected_paths: /admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*
pages_project_name: beacon
pages_environment: production
d1_binding: DB
d1_database_name: scintel
slack_client_id: 1234567890.1234567890
github_app_slug: scintel-indexer
pipeline_dispatch_repo: KnightMode/beacon
pipeline_dispatch_event: index-repo
auth_domain: beacon-90k.cloudflareaccess.com
session_duration: 24h
```

### Local command

You can also run the same split locally with an API token that has the required
permissions:

```bash
cd terraform/environments/production

CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<api-token> \
TF_VAR_cloudflare_account_id=<account-id> \
TF_VAR_enable_admin_access=true \
TF_VAR_access_allowed_emails_csv=differentialcircuit@gmail.com \
terraform apply

cd ../../..

PAGES_ADMIN_ACCESS_ENABLED=true \
PAGES_ADMIN_CF_ACCESS_ISSUER="$(cd terraform/environments/production && terraform output -raw admin_access_issuer)" \
PAGES_ADMIN_CF_ACCESS_AUD="$(cd terraform/environments/production && terraform output -raw admin_access_audience_csv)" \
PAGES_ADMIN_CF_ACCESS_ALLOWED_EMAILS="$(cd terraform/environments/production && terraform output -raw admin_access_allowed_emails_csv)" \
PAGES_ADMIN_CF_ACCESS_ALLOWED_DOMAINS="$(cd terraform/environments/production && terraform output -raw admin_access_allowed_domains_csv)" \
PAGES_D1_DATABASE_ID="$(cd terraform/environments/production && terraform output -raw d1_database_id)" \
PAGES_SLACK_CLIENT_ID=1234567890.1234567890 \
PAGES_ADMIN_SESSION_SECRET=<session-secret> \
PAGES_SLACK_CLIENT_SECRET=<slack-client-secret> \
PAGES_SLACK_TOKEN_ENCRYPTION_SECRET=<token-encryption-secret> \
PAGES_GITHUB_APP_SLUG=scintel-indexer \
PAGES_PIPELINE_DISPATCH_REPO=KnightMode/beacon \
PAGES_PIPELINE_DISPATCH_EVENT=index-repo \
PAGES_PIPELINE_DISPATCH_TOKEN=<github-token-with-repository-dispatch-access> \
node scripts/configure-pages-runtime.mjs
```

The workflow applies Terraform for the One-time PIN identity provider,
path-scoped Access applications, and `Allow approved email OTP` policies. It
also applies the idempotent tenant migrations to the configured remote D1
database. It then updates the Pages project's `production` runtime variables
with the Access issuer, audience, and optional in-app email/domain allow-list
while preserving unrelated Pages environment variables, and it binds the Pages
D1 `DB` binding to the Terraform-managed database. Finally, it deploys the Pages
site so the new runtime variables and bindings are available to the middleware.
The workflow fails fast if the required admin runtime variables or D1 binding
config are missing, instead of letting the deployed site redirect back with a
missing-config error.

The Pages app also verifies Cloudflare Access at runtime. For any non-local
request to `/admin`, `/api/admin`, `/oauth/slack/callback`, or
`/oauth/github/callback`, the Pages middleware validates the
`Cf-Access-Jwt-Assertion` signature against your team certs, checks the issuer
and audience, and optionally enforces `ADMIN_CF_ACCESS_ALLOWED_EMAILS` or
`ADMIN_CF_ACCESS_ALLOWED_DOMAINS`.

The workflow writes these Cloudflare Pages vars automatically:

```text
SLACK_CLIENT_ID=<Slack OAuth client id>
ADMIN_SESSION_SECRET=<GitHub Actions secret>
SLACK_CLIENT_SECRET=<GitHub Actions secret>
SLACK_TOKEN_ENCRYPTION_SECRET=<GitHub Actions secret>
GITHUB_APP_SLUG=scintel-indexer
GITHUB_APP_ID=<GitHub App id>
GITHUB_APP_PRIVATE_KEY=<GitHub Actions secret>
PIPELINE_DISPATCH_REPO=KnightMode/beacon
PIPELINE_DISPATCH_EVENT=index-repo
PIPELINE_DISPATCH_TOKEN=<GitHub Actions secret>
ADMIN_CF_ACCESS_ISSUER=https://beacon-90k.cloudflareaccess.com
ADMIN_CF_ACCESS_AUD=<comma-separated audience tags generated by Cloudflare Access>
ADMIN_CF_ACCESS_ALLOWED_EMAILS=differentialcircuit@gmail.com
ADMIN_CF_ACCESS_ALLOWED_DOMAINS=
```

The workflow also writes this Pages binding:

```text
DB=<D1 database id from terraform output d1_database_id>
```

If `ADMIN_CF_ACCESS_ISSUER` or `ADMIN_CF_ACCESS_AUD` is missing in a deployed
environment, admin routes fail closed with `403`.

If existing Access resources already exist, import them into Terraform before
the first apply. Otherwise Terraform will attempt to create its declared state.

Cloudflare only sends OTP email to users allowed by an Access policy. If the
login page says a code was sent but no email arrives, verify the entered email
matches the policy and allowlist `noreply@notify.cloudflare.com` in any mail
security scanner.

## Troubleshooting

If Terraform fails with an Access authentication error, the token is missing
`Access: Apps and Policies Write` or `Access: Organizations, Identity Providers,
and Groups Write`.

If the Pages runtime sync fails at `/pages/projects` with `Authentication
error`, the token is missing `Cloudflare Pages: Edit`. Add that permission and
rerun the workflow; Terraform-managed resources will remain in state.

If Terraform plans to replace `cloudflare_d1_database.scintel`, stop and import
the existing D1 database first. Do not let Terraform create a second production
control-plane database.

If Slack OAuth redirects back with `Cannot read properties of undefined
(reading 'batch')`, the deployed Pages environment is missing the `DB` D1
binding. Rerun `Configure site Access` after this change lands; the workflow
will bind `DB` to `scintel` and redeploy Pages.

If Slack OAuth redirects back with `D1_ERROR: no such table: tenants`, the
remote D1 database is missing the tenant migration. Rerun `Configure site
Access`; it applies the admin tenant migrations before redeploying Pages.

## Temporarily make the admin portal public

Run the `Make site public` workflow. It deletes the Access applications for the
configured admin paths by applying Terraform with `enable_admin_access=false`
and removes the `ADMIN_CF_ACCESS_*` runtime vars from the Pages project. It does
not delete the D1 database, queues, Pages custom domain, or OTP identity
provider, so you can re-enable login later by running `Configure site Access`.
This workflow has the same `confirm_imported_state` guard and will not run
Terraform until the existing resources are present in state.

Local equivalent:

```bash
cd terraform/environments/production

CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<api-token> \
TF_VAR_cloudflare_account_id=<account-id> \
TF_VAR_enable_admin_access=false \
terraform apply

cd ../../..

PAGES_ADMIN_ACCESS_ENABLED=false \
PAGES_REQUIRE_ADMIN_RUNTIME_CONFIG=false \
PAGES_D1_DATABASE_ID="$(cd terraform/environments/production && terraform output -raw d1_database_id)" \
node scripts/configure-pages-runtime.mjs
```
