/**
 * Fallback chunker for recognized-but-unparsed text files: fixed-size line
 * windows. Used for languages without a wired-up tree-sitter grammar.
 */

import {
  CHUNK_TYPES,
  type CodeChunk,
  chunkId,
  sha256Hex,
  MAX_CHUNK_CHARS,
} from '@scintel/shared';

const WINDOW_LINES = 120;
const OVERLAP_LINES = 10;

export interface GenericChunkInput {
  repoId: string;
  fileId: string;
  path: string;
  language: string | null;
  content: string;
  commitSha: string | null;
}

export async function chunkGeneric(
  input: GenericChunkInput,
): Promise<CodeChunk[]> {
  const lines = input.content.split('\n');
  const chunks: CodeChunk[] = [];

  for (let start = 0; start < lines.length; start += WINDOW_LINES - OVERLAP_LINES) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    const slice = lines.slice(start, end).join('\n').trim();
    if (slice === '') {
      if (end >= lines.length) break;
      continue;
    }
    const startLine = start + 1;
    const endLine = end;
    const content = slice.slice(0, MAX_CHUNK_CHARS);
    const id = await chunkId(
      input.repoId,
      input.path,
      CHUNK_TYPES.GENERIC,
      startLine,
      endLine,
      null,
    );
    const contentHash = await sha256Hex(content);
    chunks.push({
      id,
      repoId: input.repoId,
      fileId: input.fileId,
      path: input.path,
      language: input.language,
      chunkType: CHUNK_TYPES.GENERIC,
      symbol: null,
      startLine,
      endLine,
      content,
      contentHash,
      commitSha: input.commitSha,
      imports: [],
      calls: [],
      redacted: false,
    });
    if (end >= lines.length) break;
  }
  return chunks;
}
