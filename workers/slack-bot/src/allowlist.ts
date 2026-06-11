/**
 * Prototype auth: retrieval is restricted to repo_ids present (and enabled) in
 * the `prototype_repo_allowlist` table.
 */

import type { Env } from './env.js';

const CACHE_TTL_MS = 45_000;

let cached: { ids: string[]; expiresAt: number } | null = null;

export async function getAllowlistedRepoIds(env: Env): Promise<string[]> {
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
