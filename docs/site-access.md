# Protect the marketing site with Cloudflare Access

The marketing site deploys from `site/` to Cloudflare Pages as the `beacon`
project. Use the manual `Configure site Access` GitHub Actions workflow to put
the public hostname behind Cloudflare Access and allow login by email one-time
PIN.

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
4. Enter either `allowed_emails`, `allowed_domains`, or both.

Example values:

```text
allowed_emails: differentialcircuit@gmail.com
allowed_domains: example.com
site_hostname: beacon-90k.pages.dev
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
npm run configure:site-access
```

The workflow creates or reuses a Cloudflare One-time PIN identity provider,
creates or reuses an Access self-hosted application for the hostname, and
creates or updates an allow policy named `Allow approved email OTP`.

If the Access application already has an explicit identity-provider allow-list,
the script adds the One-time PIN provider to that list. If the allow-list is
empty, Cloudflare already allows all configured identity providers.

Cloudflare only sends OTP email to users allowed by an Access policy. If the
login page says a code was sent but no email arrives, verify the entered email
matches the policy and allowlist `noreply@notify.cloudflare.com` in any mail
security scanner.
