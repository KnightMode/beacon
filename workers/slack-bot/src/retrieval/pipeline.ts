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
import { agenticRetrieve } from './agent.js';

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
): Promise<RetrievalOutcome> {
  if (env.AGENTIC_RETRIEVAL !== 'false') {
    try {
      return await agenticRetrieve(env, question, searchText);
    } catch (err) {
      console.error('agentic retrieval failed; falling back to single-shot', {
        error: (err as Error).message,
      });
    }
  }
  return retrieve(env, question, searchText);
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
  const allowlist = await getAllowlistedRepoIds(env);

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
