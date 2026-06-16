/**
 * Retrieval helpers backed by normalized SCIP facts.
 *
 * SCIP rows provide precise definitions/references across Java, JS/TS, Go and
 * Python once the indexer ingests them. The helpers return normal chunks so the
 * existing rerank/context/citation path does not need a second evidence type.
 */

import type { ChunkType, RetrievedChunk, ScipReferenceRole } from '@scintel/shared';
import type { Env } from '../env.js';
import type { ParsedQuery } from './queryUnderstanding.js';

const DEFINITION_SCORE = 0.92;
const REFERENCE_SCORE = 0.72;
const MAX_NEEDLES = 12;

interface ChunkRow {
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
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export async function scipSearch(
  env: Env,
  parsed: ParsedQuery,
  allowlist: string[],
): Promise<RetrievedChunk[]> {
  if (allowlist.length === 0) return [];
  const needles = scipNeedles(parsed);
  if (needles.length === 0) return [];

  try {
    const [definitions, references] = await Promise.all([
      fetchScipDefinitions(env, needles, allowlist, 10),
      fetchScipReferences(env, needles, allowlist, ['reference', 'implementation'], 10),
    ]);
    return [...definitions, ...references];
  } catch (err) {
    console.warn('SCIP retrieval failed; continuing without SCIP evidence', {
      error: (err as Error).message,
    });
    return [];
  }
}

export async function fetchScipDefinitions(
  env: Env,
  symbols: string[],
  allowlist: string[],
  limit = 10,
): Promise<RetrievedChunk[]> {
  if (symbols.length === 0 || allowlist.length === 0) return [];
  const needles = symbols.slice(0, MAX_NEEDLES);
  const { clause, params } = symbolClause(needles, 's');
  const sql = `
    SELECT DISTINCT c.id, c.repo_id, r.full_name, c.path, c.language,
           c.chunk_type, c.symbol, c.start_line, c.end_line, c.content, c.commit_sha
    FROM scip_symbols s
    JOIN chunks c ON c.repo_id = s.repo_id
      AND c.path = s.path
      AND c.start_line <= s.end_line
      AND c.end_line >= s.start_line
    JOIN repos r ON r.id = c.repo_id
    WHERE s.repo_id IN (${placeholders(allowlist.length)})
      AND (${clause})
    ORDER BY
      CASE WHEN c.id = s.definition_chunk_id THEN 0 ELSE 1 END,
      (c.end_line - c.start_line) ASC
    LIMIT ?`;
  const { results } = await env.DB.prepare(sql)
    .bind(...allowlist, ...params, limit)
    .all<ChunkRow>();
  return results.map((row) => rowToChunk(row, DEFINITION_SCORE));
}

export async function fetchScipReferences(
  env: Env,
  symbols: string[],
  allowlist: string[],
  roles: ScipReferenceRole[] = ['reference', 'implementation', 'override'],
  limit = 12,
): Promise<RetrievedChunk[]> {
  if (symbols.length === 0 || allowlist.length === 0 || roles.length === 0) {
    return [];
  }
  const needles = symbols.slice(0, MAX_NEEDLES);
  const { clause, params } = symbolClause(needles, 's');
  const sql = `
    SELECT DISTINCT c.id, c.repo_id, repo.full_name, c.path, c.language,
           c.chunk_type, c.symbol, c.start_line, c.end_line, c.content, c.commit_sha
    FROM scip_symbols s
    JOIN scip_references ref ON ref.symbol_id = s.id
    JOIN chunks c ON c.repo_id = ref.repo_id
      AND c.path = ref.path
      AND c.start_line <= ref.end_line
      AND c.end_line >= ref.start_line
    JOIN repos repo ON repo.id = c.repo_id
    WHERE s.repo_id IN (${placeholders(allowlist.length)})
      AND ref.role IN (${placeholders(roles.length)})
      AND (${clause})
    ORDER BY
      CASE WHEN ref.enclosing_symbol IS NOT NULL THEN 0 ELSE 1 END,
      (c.end_line - c.start_line) ASC
    LIMIT ?`;
  const { results } = await env.DB.prepare(sql)
    .bind(...allowlist, ...roles, ...params, limit)
    .all<ChunkRow>();
  return results.map((row) => rowToChunk(row, REFERENCE_SCORE));
}

function scipNeedles(parsed: ParsedQuery): string[] {
  return [...new Set([...parsed.symbols, ...parsed.terms])]
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .slice(0, MAX_NEEDLES);
}

function symbolClause(
  needles: string[],
  alias: string,
): { clause: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const needle of needles) {
    clauses.push(`(${alias}.symbol = ? OR ${alias}.display_name = ? OR ${alias}.symbol LIKE ?)`);
    params.push(needle, needle, `%${needle}`);
  }
  return { clause: clauses.join(' OR '), params };
}

function rowToChunk(row: ChunkRow, score: number): RetrievedChunk {
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
    source: 'scip',
  };
}
