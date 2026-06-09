/**
 * Lexical search over D1 chunks (symbol / path / content LIKE), restricted to
 * allowlisted repos. Complements vector search with exact-token recall.
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
}

export async function lexicalSearch(
  env: Env,
  query: ParsedQuery,
  allowlist: string[],
  limit = 25,
): Promise<RetrievedChunk[]> {
  if (allowlist.length === 0) return [];

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
    score: scoreLexical(row, query),
    source: 'lexical' as const,
  }));
}

function scoreLexical(row: LexRow, query: ParsedQuery): number {
  let score = 0.4;
  if (row.symbol && query.symbols.includes(row.symbol)) score += 0.4;
  if (row.symbol && query.symbols.some((s) => row.symbol === s)) score += 0.1;
  return Math.min(score, 0.95);
}
