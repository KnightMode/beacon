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
): Promise<RetrievalOutcome> {
  if (env.AGENTIC_RETRIEVAL !== 'false') {
    try {
      return await agenticRetrieve(env, question, searchText, onProgress);
    } catch (err) {
      console.error('agentic retrieval failed; falling back to single-shot', {
        error: (err as Error).message,
      });
    }
  }
  return retrieve(env, question, searchText);
}

/**
 * When the question names an indexed repo (e.g. "how does viper work"),
 * restrict retrieval to it so other repos' content can't pollute the answer.
 * Falls back to all repos when nothing matches.
 */
export function scopeAllowlist(query: string, allowlist: string[]): string[] {
  const q = query.toLowerCase();
  const matched = allowlist.filter((id) => {
    if (q.includes(id)) return true; // explicit owner/name
    const name = id.split('/')[1] ?? '';
    if (name.length < 3) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(q)) return true;
    const spaced = name.replace(/-/g, ' ');
    return spaced !== name && q.includes(spaced);
  });
  return matched.length > 0 ? matched : allowlist;
}

export async function retrieve(
  env: Env,
  question: string,
  searchText?: string,
): Promise<RetrievalOutcome> {
  // searchText may be an enriched follow-up query (prev question + current);
  // the LLM still receives the real `question` separately.
  const query = searchText ?? question;
  const parsed = parseQuery(query);
  const allowlist = scopeAllowlist(query, await getAllowlistedRepoIds(env));

  if (allowlist.length === 0) {
    return {
      parsed,
      allowlist,
      candidates: 0,
      packed: { contextText: '', used: [], citations: [] },
    };
  }

  const [lexical, vectorRaw] = await Promise.all([
    safe(lexicalSearch(env, parsed, allowlist)),
    safe(vectorSearch(env, query, allowlist)),
  ]);
  const vector = await hydrateContent(env, vectorRaw);

  const seeds = rerank(parsed, [vector, lexical], 8);
  const graph = await safe(graphExpand(env, seeds, allowlist));

  const ranked = rerank(parsed, [vector, lexical, graph]);
  const packed = packContext(ranked);

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
