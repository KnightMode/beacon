/**
 * Tenant auth: retrieval is restricted to repos selected for the Slack
 * workspace tenant. Prototype allowlist remains as a fallback for older local
 * installs and tests that do not send a Slack team id.
 */

import type { Env } from './env.js';
import { getTenantRepoAccess } from './tenant.js';

const CACHE_TTL_MS = 45_000;

let cached: { ids: string[]; expiresAt: number } | null = null;

export async function getAllowlistedRepoIds(
  env: Env,
  teamId?: string,
): Promise<string[]> {
  const tenantAccess = await getTenantRepoAccess(env, teamId);
  if (tenantAccess) return tenantAccess.repoIds;

  // A Slack workspace id means this is a tenant-scoped request. If the
  // workspace has not onboarded, do not fall back to the legacy non-tenant allowlist.
  if (teamId) return [];

  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.ids;
  }
  const { results } = await env.DB.prepare(
    `SELECT repo_id FROM prototype_repo_allowlist WHERE enabled = 1`,
  ).all<{ repo_id: string }>();
  const ids = results.map((r) => r.repo_id);
  cached = { ids, expiresAt: now + CACHE_TTL_MS };
  return ids;
}
