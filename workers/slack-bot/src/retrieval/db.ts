/**
 * D1 helpers for retrieval: hydrating vector matches with chunk content, and
 * fetching chunks by symbol (used by graph expansion).
 */

import type { ChunkType, RetrievedChunk } from '@scintel/shared';
import type { Env } from '../env.js';

interface ChunkRowLite {
  id: string;
  repo_id: string;
  full_name: string;
  path: string;
  language: string | null;
  chunk_type: ChunkType;
  symbol: string | null;
  start_line: number;
  end_line: number;
  content: string;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/** Fill in content (and any missing fields) for chunks fetched from Vectorize. */
export async function hydrateContent(
  env: Env,
  chunks: RetrievedChunk[],
): Promise<RetrievedChunk[]> {
  const missing = chunks.filter((c) => c.content === '').map((c) => c.id);
  if (missing.length === 0) return chunks;

  const rows = await fetchChunkRowsByIds(env, missing);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return chunks.map((c) => {
    if (c.content !== '') return c;
    const row = byId.get(c.id);
    if (!row) return c;
    return {
      ...c,
      repoFullName: row.full_name,
      path: row.path,
      language: row.language,
      chunkType: row.chunk_type,
      symbol: row.symbol,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
    };
  });
}

async function fetchChunkRowsByIds(
  env: Env,
  ids: string[],
): Promise<ChunkRowLite[]> {
  if (ids.length === 0) return [];
  const sql = `
    SELECT c.id, c.repo_id, r.full_name, c.path, c.language, c.chunk_type,
           c.symbol, c.start_line, c.end_line, c.content
    FROM chunks c JOIN repos r ON r.id = c.repo_id
    WHERE c.id IN (${placeholders(ids.length)})`;
  const { results } = await env.DB.prepare(sql).bind(...ids).all<ChunkRowLite>();
  return results;
}

const DEFINITION_TYPES = [
  'function',
  'method',
  'class',
  'struct',
  'type',
  'interface',
];

export async function fetchChunksBySymbols(
  env: Env,
  symbols: string[],
  allowlist: string[],
  limit = 10,
): Promise<RetrievedChunk[]> {
  if (symbols.length === 0 || allowlist.length === 0) return [];
  const params: unknown[] = [
    ...allowlist,
    ...symbols,
    ...DEFINITION_TYPES,
    limit,
  ];
  const sql = `
    SELECT c.id, c.repo_id, r.full_name, c.path, c.language, c.chunk_type,
           c.symbol, c.start_line, c.end_line, c.content
    FROM chunks c JOIN repos r ON r.id = c.repo_id
    WHERE c.repo_id IN (${placeholders(allowlist.length)})
      AND c.symbol IN (${placeholders(symbols.length)})
      AND c.chunk_type IN (${placeholders(DEFINITION_TYPES.length)})
    LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...params).all<ChunkRowLite>();
  return results.map((row) => ({
    id: row.id,
    repoId: row.repo_id,
    repoFullName: row.full_name,
    path: row.path,
    language: row.language,
    chunkType: row.chunk_type,
    symbol: row.symbol,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    score: 0.3,
    source: 'graph' as const,
  }));
}
