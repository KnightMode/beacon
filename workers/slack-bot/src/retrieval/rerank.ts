/**
 * Merge + rerank retrieved chunks from lexical / vector / graph sources.
 * Heuristics: dedupe by id (keep best score + content), boost exact symbol
 * matches, reward semantic score, and apply a light diversity pass so the
 * context isn't dominated by a single file or chunk type.
 */

import { MAX_CONTEXT_CHUNKS, type RetrievedChunk } from '@scintel/shared';
import type { ParsedQuery } from './queryUnderstanding.js';

const SOURCE_WEIGHT: Record<RetrievedChunk['source'], number> = {
  vector: 1.0,
  scip: 1.0,
  zoekt: 1.0,
  lexical: 0.85,
  graph: 0.6,
};

const SOURCE_BONUS: Partial<Record<RetrievedChunk['source'], number>> = {
  scip: 0.18,
  zoekt: 0.15,
};

export function rerank(
  query: ParsedQuery,
  groups: RetrievedChunk[][],
  topN = MAX_CONTEXT_CHUNKS,
): RetrievedChunk[] {
  const merged = new Map<string, RetrievedChunk>();

  for (const group of groups) {
    for (const chunk of group) {
      const existing = merged.get(chunk.id);
      if (!existing) {
        merged.set(chunk.id, { ...chunk, sources: chunkSources(chunk) });
      } else {
        existing.score = Math.max(existing.score, chunk.score);
        if (existing.content === '' && chunk.content !== '') {
          existing.content = chunk.content;
        }
        existing.sources = mergeSources(existing, chunk);
      }
    }
  }

  const symbolSet = new Set(query.symbols);
  const needles = queryNeedles(query);
  const scored = [...merged.values()].map((c) => {
    const sources = chunkSources(c);
    const pathAligned = matchesQueryPath(c, needles);
    const queryAligned = pathAligned || matchesQuerySymbol(c, needles);
    let score = c.score * SOURCE_WEIGHT[c.source];
    if (pathAligned) score += 0.25;
    if (queryAligned) score += sourceBonus(sources);
    if (queryAligned && sources.length > 1) score += 0.08;
    if (c.symbol && symbolSet.has(c.symbol)) score += 0.5;
    if (c.symbol && query.terms.includes(c.symbol.toLowerCase())) score += 0.15;
    if (query.intent === 'definition' && isDefinition(c)) score += 0.1;
    return { chunk: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return diversify(scored.map((s) => s.chunk)).slice(0, topN);
}

function chunkSources(chunk: RetrievedChunk): RetrievedChunk['source'][] {
  return [...new Set([...(chunk.sources ?? []), chunk.source])];
}

function mergeSources(
  existing: RetrievedChunk,
  incoming: RetrievedChunk,
): RetrievedChunk['source'][] {
  return [...new Set([...chunkSources(existing), ...chunkSources(incoming)])];
}

function sourceBonus(sources: RetrievedChunk['source'][]): number {
  return sources.reduce((score, source) => score + (SOURCE_BONUS[source] ?? 0), 0);
}

function matchesQueryPath(c: RetrievedChunk, needles: string[]): boolean {
  const path = c.path.toLowerCase();
  const compactPath = compactIdentifier(c.path);
  return needles.some(
    (needle) => path.includes(needle) || compactPath.includes(compactIdentifier(needle)),
  );
}

function matchesQuerySymbol(c: RetrievedChunk, needles: string[]): boolean {
  if (!c.symbol) return false;
  const symbol = c.symbol.toLowerCase();
  const compactSymbol = compactIdentifier(c.symbol);
  return needles.some(
    (needle) => symbol.includes(needle) || compactSymbol.includes(compactIdentifier(needle)),
  );
}

function queryNeedles(query: ParsedQuery): string[] {
  const values = [...query.terms, ...query.symbols.map((s) => s.toLowerCase())];
  return [...new Set(values.flatMap((value) => [value, singular(value)]))]
    .filter((value) => value.length > 2);
}

function singular(value: string): string {
  return value.endsWith('s') && value.length > 3 ? value.slice(0, -1) : value;
}

function compactIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDefinition(c: RetrievedChunk): boolean {
  return (
    c.chunkType === 'function' ||
    c.chunkType === 'method' ||
    c.chunkType === 'class' ||
    c.chunkType === 'struct' ||
    c.chunkType === 'type' ||
    c.chunkType === 'interface'
  );
}

/** Cap per-file dominance to keep a variety of files in context. */
function diversify(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const perFile = new Map<string, number>();
  const kept: RetrievedChunk[] = [];
  const overflow: RetrievedChunk[] = [];
  for (const c of chunks) {
    const key = `${c.repoFullName}:${c.path}`;
    const count = perFile.get(key) ?? 0;
    if (count < 3) {
      perFile.set(key, count + 1);
      kept.push(c);
    } else {
      overflow.push(c);
    }
  }
  return [...kept, ...overflow];
}
