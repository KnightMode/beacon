import { describe, expect, it } from 'vitest';
import { partitionTargetsByBlobSha } from '../src/core/blobSkip.js';
import type { TreeEntry } from '../src/github.js';

function entry(path: string, sha: string): TreeEntry {
  return { path, type: 'blob', sha };
}

describe('partitionTargetsByBlobSha', () => {
  const repoId = 'acme/widget';
  const fileIdFn = (_repo: string, path: string) => `${repoId}:${path}`;

  it('sends all targets to work when force is true', () => {
    const targets = [entry('a.ts', 'sha-a'), entry('b.ts', 'sha-b')];
    const prior = new Map([[fileIdFn(repoId, 'a.ts'), 'sha-a']]);
    const result = partitionTargetsByBlobSha(targets, repoId, prior, true, fileIdFn);
    expect(result.unchanged).toEqual([]);
    expect(result.work).toEqual(targets);
  });

  it('skips files whose Git blob SHA matches the stored value', () => {
    const targets = [
      entry('src/unchanged.ts', 'blob-1'),
      entry('src/changed.ts', 'blob-2'),
      entry('src/new.ts', 'blob-3'),
    ];
    const prior = new Map([[fileIdFn(repoId, 'src/unchanged.ts'), 'blob-1']]);
    const result = partitionTargetsByBlobSha(targets, repoId, prior, false, fileIdFn);
    expect(result.unchanged.map((e) => e.path)).toEqual(['src/unchanged.ts']);
    expect(result.work.map((e) => e.path)).toEqual(['src/changed.ts', 'src/new.ts']);
  });

  it('treats missing prior blob SHA as work', () => {
    const targets = [entry('only.ts', 'blob-x')];
    const result = partitionTargetsByBlobSha(targets, repoId, new Map(), false, fileIdFn);
    expect(result.unchanged).toEqual([]);
    expect(result.work).toEqual(targets);
  });
});
