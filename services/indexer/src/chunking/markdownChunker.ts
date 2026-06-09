/**
 * Markdown chunker: splits a document into sections by ATX headings (`#`..).
 * Each section becomes one `markdown_section` chunk whose symbol is the heading
 * text. Content before the first heading becomes a preamble chunk.
 */

import {
  CHUNK_TYPES,
  type CodeChunk,
  chunkId,
  sha256Hex,
  MAX_CHUNK_CHARS,
} from '@scintel/shared';

export interface MarkdownChunkInput {
  repoId: string;
  fileId: string;
  path: string;
  content: string;
  commitSha: string | null;
}

interface Section {
  heading: string | null;
  startLine: number;
  endLine: number;
  lines: string[];
}

export async function chunkMarkdown(
  input: MarkdownChunkInput,
): Promise<CodeChunk[]> {
  const lines = input.content.split('\n');
  const sections: Section[] = [];
  let current: Section = { heading: null, startLine: 1, endLine: 1, lines: [] };

  const headingRe = /^(#{1,6})\s+(.*\S)\s*$/;
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const m = headingRe.exec(line);
    if (m) {
      if (current.lines.length > 0 || current.heading !== null) {
        current.endLine = lineNo - 1;
        sections.push(current);
      }
      current = { heading: m[2]!, startLine: lineNo, endLine: lineNo, lines: [line] };
    } else {
      current.lines.push(line);
    }
  });
  current.endLine = lines.length;
  if (current.lines.length > 0 || current.heading !== null) sections.push(current);

  const chunks: CodeChunk[] = [];
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (text === '') continue;
    const content = text.slice(0, MAX_CHUNK_CHARS);
    const id = await chunkId(
      input.repoId,
      input.path,
      CHUNK_TYPES.MARKDOWN_SECTION,
      section.startLine,
      section.endLine,
      section.heading,
    );
    const contentHash = await sha256Hex(content);
    chunks.push({
      id,
      repoId: input.repoId,
      fileId: input.fileId,
      path: input.path,
      language: 'markdown',
      chunkType: CHUNK_TYPES.MARKDOWN_SECTION,
      symbol: section.heading,
      startLine: section.startLine,
      endLine: section.endLine,
      content,
      contentHash,
      commitSha: input.commitSha,
      imports: [],
      calls: [],
      redacted: false,
    });
  }
  return chunks;
}
