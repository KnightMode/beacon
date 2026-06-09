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
  lexical: 0.85,
  graph: 0.6,
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
        merged.set(chunk.id, { ...chunk });
      } else {
        existing.score = Math.max(existing.score, chunk.score);
        if (existing.content === '' && chunk.content !== '') {
          existing.content = chunk.content;
        }
      }
    }
  }

  const symbolSet = new Set(query.symbols);
  const scored = [...merged.values()].map((c) => {
    let score = c.score * SOURCE_WEIGHT[c.source];
    if (c.symbol && symbolSet.has(c.symbol)) score += 0.5;
    if (c.symbol && query.terms.includes(c.symbol.toLowerCase())) score += 0.15;
    if (query.intent === 'definition' && isDefinition(c)) score += 0.1;
    return { chunk: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return diversify(scored.map((s) => s.chunk)).slice(0, topN);
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
