import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../src/chunking/markdownChunker.js';

describe('chunkMarkdown', () => {
  it('splits by headings and captures heading symbols', async () => {
    const content = [
      '# Title',
      'intro paragraph',
      '',
      '## Setup',
      'do the thing',
      '',
      '## Usage',
      'run it',
    ].join('\n');

    const chunks = await chunkMarkdown({
      repoId: 'org/repo',
      fileId: 'org/repo:README.md',
      path: 'README.md',
      content,
      commitSha: null,
    });

    const headings = chunks.map((c) => c.symbol);
    expect(headings).toContain('Title');
    expect(headings).toContain('Setup');
    expect(headings).toContain('Usage');
    expect(chunks.every((c) => c.chunkType === 'markdown_section')).toBe(true);
    expect(chunks.every((c) => c.startLine <= c.endLine)).toBe(true);
  });

  it('handles content with no headings', async () => {
    const chunks = await chunkMarkdown({
      repoId: 'org/repo',
      fileId: 'org/repo:notes.md',
      path: 'notes.md',
      content: 'just some text\nwith two lines',
      commitSha: null,
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.symbol).toBeNull();
  });
});
