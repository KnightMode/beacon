/**
 * Retrieval pipeline orchestration:
 *   query understanding -> lexical + vector search -> hydrate -> graph expansion
 *   -> rerank -> context packing.
 */

import type { RetrievedChunk } from '@scintel/shared';
import type { Env } from '../env.js';
import { getAllowlistedRepoIds } from '../allowlist.js';
import { parseQuery, type ParsedQuery } from './queryUnderstanding.js';
import { lexicalSearch } from './lexical.js';
import { vectorSearch } from './vector.js';
import { graphExpand } from './graph.js';
import { hydrateContent } from './db.js';
import { rerank } from './rerank.js';
import { packContext, type PackedContext } from './pack.js';
import { agenticRetrieve, type ProgressFn } from './agent.js';
import { zoektSearch } from './zoekt.js';
import { scipSearch } from './scip.js';

export interface RetrievalOutcome {
  parsed: ParsedQuery;
  allowlist: string[];
  packed: PackedContext;
  candidates: number;
}

/**
 * Q&A entry point: agentic retrieval (planner loop) unless disabled via the
 * AGENTIC_RETRIEVAL var; any agent failure falls back to single-shot retrieve.
 */
export async function retrieveSmart(
  env: Env,
  question: string,
  searchText?: string,
  onProgress?: ProgressFn,
  teamId?: string,
): Promise<RetrievalOutcome> {
  if (env.AGENTIC_RETRIEVAL !== 'false') {
    try {
      return await agenticRetrieve(env, question, searchText, onProgress, teamId);
    } catch (err) {
      console.error('agentic retrieval failed; falling back to single-shot', {
        error: (err as Error).message,
      });
    }
  }
  return retrieve(env, question, searchText, teamId);
}

/**
 * When the question names an indexed repo (e.g. "how does viper work"),
 * restrict retrieval to it so other repos' content can't pollute the answer.
 * Falls back to all repos when nothing matches.
 */
export function scopeAllowlist(query: string, allowlist: string[]): string[] {
  const q = query.toLowerCase();
  const words = queryWords(q);
  const scored = allowlist
    .map((id) => ({ id, score: repoMentionScore(q, words, id) }))
    .filter((entry) => entry.score >= 3)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return allowlist;
  const best = scored[0]?.score ?? 0;
  const matched = scored.filter((entry) => entry.score === best).map((entry) => entry.id);
  return matched.length > 0 ? matched : allowlist;
}

const REPO_SCOPE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'then',
  'does',
  'work',
  'file',
  'files',
  'import',
  'imports',
  'repo',
  'repository',
]);

function queryWords(query: string): string[] {
  return (
    query
      .match(/\b[a-z][a-z0-9-]{2,}\b/g)
      ?.filter((word) => !REPO_SCOPE_STOPWORDS.has(word)) ?? []
  );
}

function repoMentionScore(query: string, words: string[], repoId: string): number {
  if (query.includes(repoId)) return 100; // explicit owner/name

  const name = repoId.split('/')[1] ?? '';
  if (name.length < 3) return 0;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escaped}\\b`).test(query)) return 80;

  const spaced = name.replace(/-/g, ' ');
  if (spaced !== name && query.includes(spaced)) return 70;

  const parts = name
    .toLowerCase()
    .split(/[-_.]+/)
    .filter((part) => part.length > 2);

  let score = 0;
  for (const part of parts) {
    if (words.some((word) => word === part || word.includes(part) || part.includes(word))) {
      score += 3;
    }
  }
  return score;
}

export async function retrieve(
  env: Env,
  question: string,
  searchText?: string,
  teamId?: string,
): Promise<RetrievalOutcome> {
  const startedAt = Date.now();
  // searchText may be an enriched follow-up query (prev question + current);
  // the LLM still receives the real `question` separately.
  const query = searchText ?? question;
  const parsed = parseQuery(query);
  const allowlist = scopeAllowlist(query, await getAllowlistedRepoIds(env, teamId));

  if (allowlist.length === 0) {
    return {
      parsed,
      allowlist,
      candidates: 0,
      packed: { contextText: '', used: [], citations: [] },
    };
  }

  const [lexical, vectorRaw, zoekt, scip] = await Promise.all([
    safe(lexicalSearch(env, parsed, allowlist)),
    safe(vectorSearch(env, query, allowlist)),
    safe(zoektSearch(env, parsed, allowlist)),
    safe(scipSearch(env, parsed, allowlist)),
  ]);
  const vector = await hydrateContent(env, vectorRaw);

  const seeds = rerank(parsed, [scip, zoekt, vector, lexical], 8);
  const graph = await safe(graphExpand(env, seeds, allowlist));

  const ranked = rerank(parsed, [scip, zoekt, vector, lexical, graph]);
  const packed = packContext(ranked);
  console.log('retrieval done', {
    mode: 'single_shot',
    allowlistCount: allowlist.length,
    sources: {
      lexical: lexical.length,
      vector: vector.length,
      zoekt: zoekt.length,
      scip: scip.length,
      graph: graph.length,
    },
    packedChunks: packed.used.length,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    parsed,
    allowlist,
    packed,
    candidates: lexical.length + vector.length + graph.length,
  };
}

async function safe(p: Promise<RetrievedChunk[]>): Promise<RetrievedChunk[]> {
  try {
    return await p;
  } catch (err) {
    console.error('retrieval stage failed', { error: (err as Error).message });
    return [];
  }
}
