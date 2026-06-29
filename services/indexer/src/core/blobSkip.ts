/**
 * Partition index targets using Git blob SHAs so unchanged files skip download
 * and re-chunking entirely.
 */

import type { TreeEntry } from '../github.js';

export interface BlobSkipPartition {
  /** Targets whose Git blob SHA matches the stored value (no work needed). */
  unchanged: TreeEntry[];
  /** Targets that need content fetch and indexing. */
  work: TreeEntry[];
}

export function partitionTargetsByBlobSha(
  targets: TreeEntry[],
  repoId: string,
  priorBlobShas: Map<string, string>,
  force: boolean,
  fileIdFn: (repoId: string, path: string) => string = defaultFileId,
): BlobSkipPartition {
  if (force) {
    return { unchanged: [], work: targets };
  }

  const unchanged: TreeEntry[] = [];
  const work: TreeEntry[] = [];
  for (const entry of targets) {
    const fileId = fileIdFn(repoId, entry.path);
    if (priorBlobShas.get(fileId) === entry.sha) {
      unchanged.push(entry);
    } else {
      work.push(entry);
    }
  }
  return { unchanged, work };
}

function defaultFileId(repoId: string, path: string): string {
  return `${repoId}:${path}`;
}
