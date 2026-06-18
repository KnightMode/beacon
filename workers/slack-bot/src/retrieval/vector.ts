/**
 * Vector search via the Vectorize binding. The query is embedded with the same
 * Workers AI model used at index time, then matches are filtered to the
 * allowlisted repos (prototype auth).
 */

import type { ChunkType, RetrievedChunk } from '@scintel/shared';
import type { Env } from '../env.js';
import { runWorkersAi } from '../workersAi.js';

interface EmbeddingResponse {
  data: number[][];
}

export async function embedQuery(env: Env, text: string): Promise<number[]> {
  const res = await runWorkersAi<EmbeddingResponse>(env, env.EMBEDDING_MODEL as keyof AiModels, {
    text: [text],
  }, { label: 'embedding' });
  return res.data[0] ?? [];
}

export async function vectorSearch(
  env: Env,
  queryText: string,
  allowlist: string[],
  topK = 30,
): Promise<RetrievedChunk[]> {
  if (allowlist.length === 0) return [];

  const vector = await embedQuery(env, queryText);
  if (vector.length === 0) return [];

  const result = await env.VECTORIZE.query(vector, {
    topK,
    returnMetadata: 'all',
  });

  const allow = new Set(allowlist);
  const out: RetrievedChunk[] = [];
  for (const match of result.matches) {
    const md = (match.metadata ?? {}) as Record<string, string | number>;
    const repoId = String(md.repo_id ?? '');
    if (!allow.has(repoId)) continue;
    out.push({
      id: match.id,
      repoId,
      repoFullName: String(md.repo_full_name ?? repoId),
      path: String(md.path ?? ''),
      language: md.language ? String(md.language) : null,
      chunkType: String(md.chunk_type ?? 'generic') as ChunkType,
      symbol: md.symbol ? String(md.symbol) : null,
      startLine: Number(md.start_line ?? 0),
      endLine: Number(md.end_line ?? 0),
      content: '',
      commitSha: md.commit_sha ? String(md.commit_sha) : null,
      score: match.score ?? 0,
      source: 'vector' as const,
    });
  }
  return out;
}
