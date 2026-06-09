/**
 * Graph expansion: one hop over `code_edges` (CALLS / IMPORTS) from the seed
 * chunks, pulling in the definitions of called symbols so the LLM sees both the
 * caller and the callee.
 */

import type { RetrievedChunk } from '@scintel/shared';
import type { Env } from '../env.js';
import { fetchChunksBySymbols } from './db.js';

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export async function graphExpand(
  env: Env,
  seeds: RetrievedChunk[],
  allowlist: string[],
  limit = 10,
): Promise<RetrievedChunk[]> {
  const seedIds = seeds.map((s) => s.id);
  if (seedIds.length === 0 || allowlist.length === 0) return [];

  const params: unknown[] = [...allowlist, ...seedIds];
  const sql = `
    SELECT DISTINCT to_symbol FROM code_edges
    WHERE repo_id IN (${placeholders(allowlist.length)})
      AND edge_type = 'CALLS'
      AND from_node_id IN (${placeholders(seedIds.length)})
      AND to_symbol IS NOT NULL`;
  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all<{ to_symbol: string }>();

  const calleeSymbols = results
    .map((r) => r.to_symbol)
    .filter((s): s is string => Boolean(s));

  // Also chase definitions of any symbols already surfaced in the seeds.
  const seedSymbols = seeds
    .map((s) => s.symbol)
    .filter((s): s is string => Boolean(s));

  const symbols = [...new Set([...calleeSymbols, ...seedSymbols])].slice(0, 20);
  const seedIdSet = new Set(seedIds);

  const expanded = await fetchChunksBySymbols(env, symbols, allowlist, limit);
  return expanded.filter((c) => !seedIdSet.has(c.id));
}
