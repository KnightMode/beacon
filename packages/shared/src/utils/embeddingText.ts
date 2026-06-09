/**
 * Builds the metadata-enriched text that is embedded for each chunk
 * (spec section 6). Prefixing the code with structured metadata measurably
 * improves retrieval, since the embedding captures repo/path/symbol context in
 * addition to the raw source.
 */

import type { CodeChunk } from '../types.js';

export interface EmbeddingTextInput {
  repoFullName: string;
  path: string;
  language: string | null;
  chunkType: string;
  symbol: string | null;
  imports: string[];
  calls: string[];
  content: string;
}

export function buildEmbeddingText(input: EmbeddingTextInput): string {
  const lines: string[] = [
    `Repo: ${input.repoFullName}`,
    `Path: ${input.path}`,
    `Language: ${input.language ?? 'unknown'}`,
    `Chunk type: ${input.chunkType}`,
  ];
  if (input.symbol) lines.push(`Symbol: ${input.symbol}`);
  if (input.imports.length) lines.push(`Imports: ${input.imports.join(', ')}`);
  if (input.calls.length) lines.push(`Calls: ${input.calls.join(', ')}`);
  lines.push('', 'Code:', input.content);
  return lines.join('\n');
}

/** Convenience overload for a fully-formed CodeChunk. */
export function embeddingTextForChunk(
  repoFullName: string,
  chunk: CodeChunk,
): string {
  return buildEmbeddingText({
    repoFullName,
    path: chunk.path,
    language: chunk.language,
    chunkType: chunk.chunkType,
    symbol: chunk.symbol,
    imports: chunk.imports,
    calls: chunk.calls,
    content: chunk.content,
  });
}
