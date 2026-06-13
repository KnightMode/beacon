# Protect the admin portal with Cloudflare Access

The marketing site deploys from `site/` to Cloudflare Pages as the `beacon`
project. The admin portal is the sensitive surface. Use the manual
`Configure site Access` GitHub Actions workflow to protect only the admin paths
with Cloudflare Access and allow login by email one-time PIN.

## Required Cloudflare token permissions

The repository already uses `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` secrets for Pages deploys. The token used by the Access
workflow must also include:

- `Access: Apps and Policies Write`
- `Access: Organizations, Identity Providers, and Groups Write`

Cloudflare Pages deploys still need `Cloudflare Pages: Edit`.

## Configure access

### GitHub Actions

After this workflow exists on GitHub, you can configure Access without exposing
Cloudflare credentials locally:

1. Open GitHub Actions.
2. Run `Configure site Access`.
3. Keep `site_hostname` as `beacon-90k.pages.dev`, unless you have attached a
   custom domain to the Pages project.
4. Keep `protected_paths` as
   `/admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*`.
5. Enter either `allowed_emails`, `allowed_domains`, or both.
6. Copy the printed `ADMIN_CF_ACCESS_ISSUER` and `ADMIN_CF_ACCESS_AUD` values
   into the Cloudflare Pages project vars.

Example values:

```text
allowed_emails: differentialcircuit@gmail.com
allowed_domains: example.com
site_hostname: beacon-90k.pages.dev
protected_paths: /admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*
auth_domain: beacon-90k.cloudflareaccess.com
session_duration: 24h
```

### Local command

You can also run the same setup locally with an API token that has the required
Access permissions:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<api-token> \
ACCESS_ALLOWED_EMAILS=differentialcircuit@gmail.com \
ACCESS_SITE_HOSTNAME=beacon-90k.pages.dev \
ACCESS_PROTECTED_PATHS='/admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*' \
ACCESS_AUTH_DOMAIN=beacon-90k.cloudflareaccess.com \
npm run configure:site-access
```

The workflow creates or reuses the Zero Trust organization, creates or reuses a
Cloudflare One-time PIN identity provider, creates or reuses path-scoped Access
self-hosted applications for the admin paths, and creates or updates an allow
policy named `Allow approved email OTP` on each application.

The Pages app also verifies Cloudflare Access at runtime. For any non-local
request to `/admin`, `/api/admin`, `/oauth/slack/callback`, or
`/oauth/github/callback`, the Pages middleware validates the
`Cf-Access-Jwt-Assertion` signature against your team certs, checks the issuer
and audience, and optionally enforces `ADMIN_CF_ACCESS_ALLOWED_EMAILS` or
`ADMIN_CF_ACCESS_ALLOWED_DOMAINS`.

Set these Cloudflare Pages vars after running the workflow:

```text
ADMIN_CF_ACCESS_ISSUER=https://beacon-90k.cloudflareaccess.com
ADMIN_CF_ACCESS_AUD=<comma-separated audience tags printed by the workflow>
ADMIN_CF_ACCESS_ALLOWED_EMAILS=differentialcircuit@gmail.com
ADMIN_CF_ACCESS_ALLOWED_DOMAINS=
```

If `ADMIN_CF_ACCESS_ISSUER` or `ADMIN_CF_ACCESS_AUD` is missing in a deployed
environment, admin routes fail closed with `403`.

If the Access application already has an explicit identity-provider allow-list,
the script adds the One-time PIN provider to that list. If the allow-list is
empty, Cloudflare already allows all configured identity providers.

Cloudflare only sends OTP email to users allowed by an Access policy. If the
login page says a code was sent but no email arrives, verify the entered email
matches the policy and allowlist `noreply@notify.cloudflare.com` in any mail
security scanner.

## Troubleshooting

If the workflow fails at `/access/apps` with `Authentication error`, the token
is missing `Access: Apps and Policies Write`. The first setup may still have
created the Zero Trust organization and OTP identity provider; after updating
the `CLOUDFLARE_API_TOKEN` secret, rerun the workflow and it will reuse those
resources.

## Temporarily make the admin portal public

Run the `Make site public` workflow. It deletes the Access applications for the
configured admin paths. It does not delete the Zero Trust organization or OTP
identity provider, so you can re-enable login later by running
`Configure site Access`.

Local equivalent:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<api-token> \
ACCESS_SITE_HOSTNAME=beacon-90k.pages.dev \
ACCESS_PROTECTED_PATHS='/admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*' \
npm run remove:site-access
```
