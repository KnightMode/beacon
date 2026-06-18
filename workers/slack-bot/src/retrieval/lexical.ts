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
  commit_sha: string | null;
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
  const needles = [...searchNeedles(query)]
    .map((n) => n.trim())
    .filter((n) => n.length > 1)
    .slice(0, 10);
  return needles.map((n) => `"${n.replace(/"/g, '""')}"*`).join(' OR ');
}

function searchNeedles(query: ParsedQuery): string[] {
  const needles: string[] = [];
  const add = (value: string | null): void => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed.length > 1 && !needles.includes(trimmed)) needles.push(trimmed);
  };

  for (const symbol of query.symbols) add(symbol);
  for (const identifier of identifierBigrams(query.terms)) add(identifier);
  for (const term of query.terms) {
    add(term);
    for (const variant of termVariants(term)) add(variant);
  }
  return needles;
}

function identifierBigrams(terms: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < terms.length - 1; i++) {
    const a = terms[i]!;
    const b = terms[i + 1]!;
    if (a.length < 3 || b.length < 3) continue;
    out.push(`${a}${b[0]!.toUpperCase()}${b.slice(1)}`);
  }
  return out;
}

function termVariants(term: string): string[] {
  const variants = new Set<string>();
  const singular = singularize(term);
  if (singular && singular !== term) variants.add(singular);
  const stemmed = stemPastTense(term);
  if (stemmed && stemmed !== term) variants.add(stemmed);
  return [...variants];
}

function singularize(term: string): string | null {
  if (term.length <= 3) return null;
  if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith('ses') && term.length > 4) return term.slice(0, -2);
  if (/(ches|shes|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return null;
}

function stemPastTense(term: string): string | null {
  if (term.length <= 4 || !term.endsWith('ed')) return null;
  if (term.endsWith('ied')) return `${term.slice(0, -3)}y`;
  if (term.endsWith('ated')) return term.slice(0, -1);
  return term.slice(0, -2);
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
           c.symbol, c.start_line, c.end_line, c.content, c.commit_sha,
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
           c.symbol, c.start_line, c.end_line, c.content, c.commit_sha
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
    commitSha: row.commit_sha,
    score,
    source: 'lexical' as const,
  };
}
