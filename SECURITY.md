# Security Policy

Beacon handles source code, GitHub App credentials, Slack tokens, and Cloudflare
secrets, so we take security seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report privately through GitHub's
[private vulnerability reporting](https://github.com/KnightMode/beacon/security/advisories/new):

1. Go to the repository's **Security** tab → **Report a vulnerability**.
2. Describe the issue, the impact, and steps to reproduce.

We aim to acknowledge reports within 5 business days and will keep you updated as
we work on a fix. Please give us a reasonable window to address the issue before
any public disclosure.

When reporting, helpful details include:

- The component affected (e.g. `slack-bot` worker, `github-webhook` worker, the
  Pages admin portal, the indexer, or `packages/shared`).
- The type of issue (auth bypass, secret exposure, injection, SSRF, tenant
  isolation gap, etc.).
- A proof of concept or reproduction steps, and the potential impact.

## Supported versions

Beacon is pre-1.0 and evolves on `main`. Security fixes are applied to `main`;
there is no separate long-term support branch yet. Run from a recent `main` to
stay current.

## Handling credentials

Beacon never stores plaintext provider secrets in the repository. The following
are gitignored and must never be committed:

- `.env`, `.env.*` (except `.env.example`)
- `.dev.vars`
- `*.private-key.pem` (GitHub App private keys)

Per-tenant Slack/GitHub tokens are encrypted at rest with AES-GCM
(`packages/shared/src/utils/secretCrypto.ts`), and the indexer redacts detected
secrets from code before embedding
(`packages/shared/src/utils/secrets.ts`).

### If a secret is ever committed

Treat any credential that has touched a tracked file — or even a local ignored
file — as compromised:

1. **Rotate it immediately** at the provider (Cloudflare API token, Slack app
   credentials, GitHub App private key, R2 keys).
2. Remove it from the working tree and from history before publishing.
3. Re-run `git log --all -p` / secret scanning to confirm it is gone.

We recommend enabling **GitHub secret scanning** and **push protection** on any
fork before the first public push.
