/**
 * Zoekt-backed exact code search.
 *
 * Beacon keeps tenant/user authorization in the Worker. The Zoekt service is
 * treated as a fast search backend: it receives an already-scoped repo list and
 * returns file/line hits. Hits are hydrated from D1 chunks when possible so the
 * rest of retrieval keeps stable citations and context packing.
 */

import { CHUNK_TYPES, type ChunkType, type RetrievedChunk } from '@scintel/shared';
import type { Env } from '../env.js';
import type { ParsedQuery } from './queryUnderstanding.js';

const DEFAULT_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_ZOEKT_QUERY_TERMS = 8;
const ZOEKT_QUERY_STOPWORDS = new Set([
  'beacon',
  'code',
  'converted',
  'generated',
  'into',
  'question',
  'questions',
  'search',
  'service',
  'used',
  'using',
]);

export interface ZoektMatch {
  repo: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score?: number;
}

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

export async function zoektSearch(
  env: Env,
  parsed: ParsedQuery,
  allowlist: string[],
  limit = DEFAULT_LIMIT,
): Promise<RetrievedChunk[]> {
  if ((!env.ZOEKT_SEARCH_URL && !env.ZOEKT_SEARCH) || allowlist.length === 0) return [];

  const query = buildZoektQuery(parsed);
  if (!query) return [];

  try {
    const matches = await fetchZoekt(env, query, allowlist, limit);
    return hydrateZoektMatches(env, matches, allowlist);
  } catch (err) {
    console.warn('Zoekt search failed; continuing without Zoekt evidence', {
      error: (err as Error).message,
    });
    return [];
  }
}

export function buildZoektQuery(parsed: ParsedQuery): string {
  const terms = uniqueZoektTerms([
    ...parsed.symbols,
    ...pathTerms(parsed.raw),
    ...parsed.terms,
  ])
    .map((term) => term.trim())
    .filter(isZoektQueryTerm);
  const query = terms
    .slice(0, MAX_ZOEKT_QUERY_TERMS)
    .map(quoteZoektTerm)
    .join(' or ');
  return query || parsed.raw.trim();
}

function uniqueZoektTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

function pathTerms(raw: string): string[] {
  return raw.match(/\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\b/g) ?? [];
}

function isZoektQueryTerm(term: string): boolean {
  const normalized = term.toLowerCase();
  return term.length > 2 && !ZOEKT_QUERY_STOPWORDS.has(normalized);
}

function quoteZoektTerm(term: string): string {
  return /[^A-Za-z0-9_./-]/.test(term) ? JSON.stringify(term) : term;
}

async function fetchZoekt(
  env: Env,
  query: string,
  repos: string[],
  limit: number,
): Promise<ZoektMatch[]> {
  if (env.ZOEKT_SEARCH) {
    return fetchZoektViaBinding(env, query, repos, limit);
  }
  if (!env.ZOEKT_SEARCH_URL) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const post = await fetch(env.ZOEKT_SEARCH_URL!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.ZOEKT_SEARCH_TOKEN
          ? { authorization: `Bearer ${env.ZOEKT_SEARCH_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ query, repos, limit }),
      signal: controller.signal,
    });
    if (post.ok) {
      const raw = await post.json();
      return normalizeZoektResponse(raw).slice(0, limit);
    }
    if (post.status === 401 || post.status === 403) {
      throw new Error(`Zoekt endpoint returned ${post.status}`);
    }

    const directUrl = directZoektUrl(env.ZOEKT_SEARCH_URL!, query, repos, limit);
    const direct = await fetch(directUrl, {
      headers: env.ZOEKT_SEARCH_TOKEN
        ? { authorization: `Bearer ${env.ZOEKT_SEARCH_TOKEN}` }
        : {},
      signal: controller.signal,
    });
    if (!direct.ok) {
      throw new Error(`Zoekt endpoint returned ${post.status}; direct fallback returned ${direct.status}`);
    }
    const raw = await direct.json();
    return normalizeZoektResponse(raw).slice(0, limit);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchZoektViaBinding(
  env: Env,
  query: string,
  repos: string[],
  limit: number,
): Promise<ZoektMatch[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await env.ZOEKT_SEARCH!.fetch('https://beacon-zoekt.internal/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.ZOEKT_SEARCH_TOKEN
          ? { authorization: `Bearer ${env.ZOEKT_SEARCH_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ query, repos, limit }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Zoekt service binding returned ${res.status}`);
    return normalizeZoektResponse(await res.json()).slice(0, limit);
  } finally {
    clearTimeout(timer);
  }
}

function directZoektUrl(base: string, query: string, repos: string[], limit: number): string {
  const url = new URL(base);
  const repoFilter = repos.map((repo) => `r:${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).join(' or ');
  const scoped = repoFilter ? `(${query}) (${repoFilter})` : query;
  url.searchParams.set('q', scoped);
  url.searchParams.set('format', 'json');
  url.searchParams.set('num', String(limit));
  url.searchParams.set('ctx', '1');
  return url.toString();
}

export function normalizeZoektResponse(raw: unknown): ZoektMatch[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const direct = Array.isArray(obj.matches) ? obj.matches : null;
  if (direct) return direct.map(normalizeDirectMatch).filter(isZoektMatch);

  // Accept the shape emitted by a thin proxy around zoekt-webserver's JSON API.
  const result = (obj.Result ?? obj.result) as Record<string, unknown> | undefined;
  const files = Array.isArray(result?.FileMatches ?? result?.fileMatches ?? result?.Files ?? result?.files)
    ? ((result?.FileMatches ?? result?.fileMatches ?? result?.Files ?? result?.files) as unknown[])
    : [];
  const out: ZoektMatch[] = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const file = f as Record<string, unknown>;
    const repo = stringValue(file.Repository ?? file.repository ?? file.Repo ?? file.repo);
    const path = stringValue(file.FileName ?? file.fileName ?? file.path ?? file.Path);
    if (!repo || !path) continue;
    const matches = Array.isArray(file.Matches ?? file.matches)
      ? ((file.Matches ?? file.matches) as unknown[])
      : [];
    for (const m of matches) {
      if (!m || typeof m !== 'object') continue;
      const match = m as Record<string, unknown>;
      const line = numberValue(match.LineNum ?? match.lineNum ?? match.line) ?? 1;
      const snippet = stringValue(match.Line ?? match.lineText ?? match.text) ?? '';
      out.push({ repo, path, startLine: line, endLine: line, snippet, score: 0.85 });
    }
  }
  return out;
}

function normalizeDirectMatch(raw: unknown): ZoektMatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const repo = stringValue(obj.repo ?? obj.repository ?? obj.repoFullName);
  const path = stringValue(obj.path ?? obj.file ?? obj.fileName);
  const startLine = numberValue(obj.startLine ?? obj.line ?? obj.lineNumber) ?? 1;
  const endLine = numberValue(obj.endLine) ?? startLine;
  const snippet = stringValue(obj.snippet ?? obj.content ?? obj.lineText) ?? '';
  if (!repo || !path) return null;
  return {
    repo,
    path,
    startLine,
    endLine,
    snippet,
    score: numberValue(obj.score) ?? 0.85,
  };
}

function isZoektMatch(match: ZoektMatch | null): match is ZoektMatch {
  return match !== null;
}

async function hydrateZoektMatches(
  env: Env,
  matches: ZoektMatch[],
  allowlist: string[],
): Promise<RetrievedChunk[]> {
  const out: RetrievedChunk[] = [];
  const allowed = new Set(allowlist);
  for (const match of matches) {
    const repoId = match.repo.toLowerCase();
    if (!allowed.has(repoId)) continue;
    const row = await findChunkForMatch(env, repoId, match);
    out.push(row ? rowToChunk(row, match.score ?? 0.85) : syntheticChunk(match, repoId));
  }
  return out;
}

async function findChunkForMatch(
  env: Env,
  repoId: string,
  match: ZoektMatch,
): Promise<ChunkRow | null> {
  const sql = `
    SELECT c.id, c.repo_id, r.full_name, c.path, c.language, c.chunk_type,
           c.symbol, c.start_line, c.end_line, c.content, c.commit_sha
    FROM chunks c JOIN repos r ON r.id = c.repo_id
    WHERE c.repo_id = ?
      AND (c.path = ? OR c.path LIKE ?)
      AND c.start_line <= ? AND c.end_line >= ?
    ORDER BY
      CASE WHEN c.symbol IS NOT NULL THEN 0 ELSE 1 END,
      (c.end_line - c.start_line) ASC
    LIMIT 1`;
  return await env.DB.prepare(sql)
    .bind(repoId, match.path, `%${match.path}`, match.endLine, match.startLine)
    .first<ChunkRow>();
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
    source: 'zoekt',
  };
}

function syntheticChunk(match: ZoektMatch, repoId: string): RetrievedChunk {
  return {
    id: `zoekt:${repoId}:${match.path}:${match.startLine}:${match.endLine}`,
    repoId,
    repoFullName: match.repo,
    path: match.path,
    language: null,
    chunkType: CHUNK_TYPES.GENERIC,
    symbol: null,
    startLine: match.startLine,
    endLine: match.endLine,
    content: match.snippet,
    commitSha: null,
    score: match.score ?? 0.75,
    source: 'zoekt',
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
