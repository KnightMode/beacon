/**
 * Prototype auth: retrieval is restricted to repo_ids present (and enabled) in
 * the `prototype_repo_allowlist` table.
 */

import type { Env } from './env.js';

export async function getAllowlistedRepoIds(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT repo_id FROM prototype_repo_allowlist WHERE enabled = 1`,
  ).all<{ repo_id: string }>();
  return results.map((r) => r.repo_id);
}
