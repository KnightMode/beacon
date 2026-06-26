# Open-source implementation

Beacon is open source under the MIT License. The source in this repository is
the implementation, not just a demo shell.

## What is included

- Cloudflare Worker for Slack commands, events, streaming answers, PR review,
  create-PR, CI triage, and tenant-aware retrieval.
- Cloudflare Worker for GitHub App webhooks, queue dispatch, install/repo grant
  tracking, and indexing jobs.
- Cloudflare Pages site plus Pages Functions for the admin onboarding portal.
- Node indexer CLI/server for GitHub tree fetching, tree-sitter chunking,
  secret redaction, embedding, D1 writes, Vectorize upserts, and optional
  Zoekt/SCIP artifact generation.
- Zoekt search container wrapper used by the Slack worker through a service
  binding or URL fallback.
- Shared D1 schema, additive migrations, types, GitHub App helpers, secret
  crypto helpers, and eval harness.

## What is not included

- Cloudflare, Slack, GitHub, R2, or Workers AI accounts.
- Real secrets, tokens, PEM files, live D1 data, Vectorize data, Zoekt shards,
  or hosted Beacon customer data.
- Managed-service operations such as billing, support, uptime guarantees, or
  production credentials.

## Self-hosting boundary

Use [setup.md](setup.md) for a self-hosted deployment. Fresh D1 databases should
apply `packages/shared/schema.sql`; existing databases should run
`scripts/apply-admin-d1-migrations.mjs`, which applies the current admin,
installation-grant, and code-intel migrations safely.

Tenant/customer repo access is intended to use GitHub App installation tokens.
The legacy `GITHUB_PAT` path remains only for local or non-tenant development
traffic.

The npm workspaces stay marked `"private": true` to prevent accidental package
publication. That does not make the source proprietary; the source license is
MIT.

## Before publishing a fork

- Do not commit `.env`, `.env.*`, `.dev.vars`, private keys, or exported
  provider secrets.
- Rotate any credential that has ever lived in a local ignored file before
  making the repository public.
- Replace example domains, D1 database ids, project names, repo names, and
  GitHub Actions defaults with your own values.
- Enable GitHub secret scanning and review workflow secrets/variables before
  the first public push.

## Current limits

The current runtime uses tenant-scoped rows inside one shared D1 database and
one shared Vectorize index. Structural per-tenant D1 databases, Vectorize
namespaces, billing, RBAC enforcement, and strict per-user GitHub permission
mirroring are documented as future work in
[multi-tenant-saas.md](multi-tenant-saas.md), [provisioning.md](provisioning.md),
and [rbac.md](rbac.md).
