/**
 * Context packing: serialize the top chunks into a numbered context block (with
 * stable [n] markers the LLM can cite) under a character budget, and return the
 * matching citation list.
 */

import type { Citation, RetrievedChunk } from '@scintel/shared';

const DEFAULT_CHAR_BUDGET = 14_000;
const PER_CHUNK_CHAR_CAP = 2_400;

export interface PackedContext {
  contextText: string;
  used: RetrievedChunk[];
  citations: Citation[];
}

export function packContext(
  chunks: RetrievedChunk[],
  charBudget = DEFAULT_CHAR_BUDGET,
): PackedContext {
  const blocks: string[] = [];
  const used: RetrievedChunk[] = [];
  const citations: Citation[] = [];
  let budget = charBudget;

  chunks.forEach((c, idx) => {
    if (budget <= 0) return;
    const body = c.content.slice(0, PER_CHUNK_CHAR_CAP);
    const header =
      `[${idx + 1}] ${c.repoFullName}/${c.path}:${c.startLine}-${c.endLine}` +
      (c.symbol ? ` (${c.chunkType} ${c.symbol})` : ` (${c.chunkType})`);
    const block = `${header}\n\`\`\`${c.language ?? ''}\n${body}\n\`\`\``;
    if (block.length > budget && used.length > 0) return;
    blocks.push(block);
    used.push(c);
    citations.push({
      repoFullName: c.repoFullName,
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
    });
    budget -= block.length;
  });

  return { contextText: blocks.join('\n\n'), used, citations };
}
