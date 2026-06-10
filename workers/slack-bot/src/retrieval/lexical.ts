/**
 * Lexical search over D1 chunks, restricted to allowlisted repos. Complements
 * vector search with exact-token recall.
 *
 * Primary path: FTS5 (`chunks_fts`) with BM25 ranking — symbol matches weigh
 * more than path matches, which weigh more than content matches. Falls back to
 * the legacy LIKE scan if the FTS table is missing (pre-migration databases).
 */

import type { ChunkType, RetrievedChunk } from '@scintel/shared';
import type { Env } from '../env.js';
import type { ParsedQuery } from './queryUnderstanding.js';

interface LexRow {
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
  rank?: number;
}

// BM25 column weights for (symbol, path, content).
const BM25_WEIGHTS = '8.0, 4.0, 1.0';

/**
 * Builds an FTS5 MATCH expression from the parsed query: each needle becomes a
 * quoted prefix phrase (`"foo bar"*`), OR-joined. Quoting makes user input safe
 * against FTS5 query syntax; the `*` keeps substring-ish recall for symbols.
 */
export function buildFtsMatch(query: ParsedQuery): string {
  const needles = [...new Set([...query.symbols, ...query.terms])]
    .map((n) => n.trim())
    .filter((n) => n.length > 1)
    .slice(0, 10);
  return needles.map((n) => `"${n.replace(/"/g, '""')}"*`).join(' OR ');
}

export async function lexicalSearch(
  env: Env,
  query: ParsedQuery,
  allowlist: string[],
  limit = 25,
): Promise<RetrievedChunk[]> {
  if (allowlist.length === 0) return [];

  const match = buildFtsMatch(query);
  if (match === '') return [];

  try {
    return await ftsSearch(env, query, match, allowlist, limit);
  } catch (err) {
    console.warn('FTS search failed; falling back to LIKE scan', {
      error: (err as Error).message,
    });
    return likeSearch(env, query, allowlist, limit);
  }
}

async function ftsSearch(
  env: Env,
  query: ParsedQuery,
  match: string,
  allowlist: string[],
  limit: number,
): Promise<RetrievedChunk[]> {
  const repoPlaceholders = allowlist.map(() => '?').join(',');
  const sql = `
    SELECT c.id, c.repo_id, r.full_name, c.path, c.language, c.chunk_type,
           c.symbol, c.start_line, c.end_line, c.content,
           bm25(chunks_fts, ${BM25_WEIGHTS}) AS rank
    FROM chunks_fts
    JOIN chunks c ON c.rowid = chunks_fts.rowid
    JOIN repos r ON r.id = c.repo_id
    WHERE chunks_fts MATCH ?
      AND c.repo_id IN (${repoPlaceholders})
    ORDER BY rank
    LIMIT ?`;

  const { results } = await env.DB.prepare(sql)
    .bind(match, ...allowlist, limit)
    .all<LexRow>();

  // bm25() returns negative values, more negative = better. Normalize to
  // (0, 0.95] relative to the best hit so scores compose with vector scores.
  const best = Math.max(...results.map((r) => Math.abs(r.rank ?? 0)), 1e-6);
  return results.map((row) => toChunk(row, scoreBm25(row, query, best)));
}

function scoreBm25(row: LexRow, query: ParsedQuery, bestAbs: number): number {
  let score = 0.35 + 0.5 * (Math.abs(row.rank ?? 0) / bestAbs);
  if (row.symbol && query.symbols.includes(row.symbol)) score += 0.1;
  return Math.min(score, 0.95);
}

/** Legacy LIKE scan, kept only as a fallback for pre-FTS databases. */
async function likeSearch(
  env: Env,
  query: ParsedQuery,
  allowlist: string[],
  limit: number,
): Promise<RetrievedChunk[]> {
  const needles = [...query.symbols, ...query.terms].slice(0, 10);
  if (needles.length === 0) return [];

  const repoPlaceholders = allowlist.map(() => '?').join(',');
  const likeClauses: string[] = [];
  const params: unknown[] = [...allowlist];

  for (const needle of needles) {
    likeClauses.push('(c.symbol LIKE ? OR c.path LIKE ? OR c.content LIKE ?)');
    const like = `%${needle}%`;
    params.push(like, like, like);
  }
  params.push(limit);

  const sql = `
    SELECT c.id, c.repo_id, r.full_name, c.path, c.language, c.chunk_type,
           c.symbol, c.start_line, c.end_line, c.content
    FROM chunks c
    JOIN repos r ON r.id = c.repo_id
    WHERE c.repo_id IN (${repoPlaceholders})
      AND (${likeClauses.join(' OR ')})
    LIMIT ?`;

  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all<LexRow>();

  return results.map((row) => toChunk(row, scoreLike(row, query)));
}

function scoreLike(row: LexRow, query: ParsedQuery): number {
  let score = 0.4;
  if (row.symbol && query.symbols.includes(row.symbol)) score += 0.4;
  return Math.min(score, 0.95);
}

function toChunk(row: LexRow, score: number): RetrievedChunk {
  return {
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
    score,
    source: 'lexical' as const,
  };
}
