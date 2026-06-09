/**
 * Repo indexing orchestration. Fetches files from GitHub, chunks them with
 * tree-sitter / markdown / generic chunkers, redacts secrets, embeds via
 * Workers AI, upserts vectors to Vectorize, and writes files/chunks/edges to D1.
 *
 * FULL_INDEX  -> (re)index every allowlisted file at HEAD.
 * INCREMENTAL -> delete-old-then-reindex changed files; delete removed files.
 */

import {
  type IndexJob,
  type CodeChunk,
  type VectorMetadata,
  shouldIndexFile,
  looksBinary,
  detectLanguage,
  isMarkdown,
  scanForSecrets,
  redactSecrets,
  buildEmbeddingText,
  sha256Hex,
} from '@scintel/shared';

import type { IndexerConfig } from '../config.js';
import { GitHubClient, type TreeEntry } from '../github.js';
import { D1Client } from '../cloudflare/d1.js';
import { VectorizeClient, type UpsertVector } from '../cloudflare/vectorize.js';
import { WorkersAIClient } from '../cloudflare/workersai.js';
import { chunkCode, canTreeSit } from '../chunking/codeChunker.js';
import { chunkMarkdown } from '../chunking/markdownChunker.js';
import { chunkGeneric } from '../chunking/genericChunker.js';
import {
  ensureRepoRow,
  setRepoStatus,
  updateIndexStatus,
  upsertFile,
  chunkIdsForFile,
  deleteFileData,
  deleteFileRow,
  insertChunks,
  insertEdges,
  repoIdFor,
  fileIdFor,
} from './store.js';
import { log } from '../logger.js';

const EMBED_BATCH = 50;

export interface IndexResult {
  repoFullName: string;
  commitSha: string;
  filesIndexed: number;
  chunksWritten: number;
  edgesWritten: number;
  filesRemoved: number;
}

export async function indexRepo(
  config: IndexerConfig,
  job: IndexJob,
): Promise<IndexResult> {
  const github = new GitHubClient(config);
  const d1 = new D1Client(config);
  const vectorize = new VectorizeClient(config);
  const ai = new WorkersAIClient(config);

  const [owner, name] = job.repoFullName.split('/');
  if (!owner || !name) {
    throw new Error(`invalid repo full name: ${job.repoFullName}`);
  }
  const repoId = repoIdFor(job.repoFullName);

  const repoInfo = await github.getRepo(owner, name);
  const commitSha =
    job.commitSha ??
    (await github.getBranchHeadSha(owner, name, repoInfo.default_branch));

  await ensureRepoRow(
    d1,
    job.repoFullName,
    repoInfo.default_branch,
    repoInfo.private,
    repoInfo.id,
  );
  await setRepoStatus(d1, repoId, 'INDEXING');
  await updateIndexStatus(d1, repoId, {
    status: 'INDEXING',
    jobType: job.jobType,
    commitSha,
    starting: true,
    error: null,
  });

  try {
    const tree = await github.getTree(owner, name, commitSha);
    const byPath = new Map<string, TreeEntry>();
    for (const entry of tree) byPath.set(entry.path, entry);

    const { targets, removed } = selectTargets(job, tree, byPath);

    // Incremental: remove deleted files entirely.
    let filesRemoved = 0;
    for (const path of removed) {
      const fileId = fileIdFor(repoId, path);
      const ids = await chunkIdsForFile(d1, fileId);
      if (ids.length) await vectorize.deleteByIds(ids);
      await deleteFileData(d1, fileId);
      await deleteFileRow(d1, fileId);
      filesRemoved++;
    }

    let filesIndexed = 0;
    let chunksWritten = 0;
    let edgesWritten = 0;

    for (const entry of targets) {
      const content = await github.getBlobContent(owner, name, entry.sha);
      if (content === null || looksBinary(content)) continue;

      const language = detectLanguage(entry.path);
      const fileHash = await sha256Hex(content);
      const fileId = await upsertFile(d1, {
        repoId,
        path: entry.path,
        language,
        sizeBytes: entry.size ?? content.length,
        contentHash: fileHash,
        commitSha,
      });

      // Delete-old-then-reindex: clear previous chunks + vectors for this file.
      const oldIds = await chunkIdsForFile(d1, fileId);
      if (oldIds.length) await vectorize.deleteByIds(oldIds);
      await deleteFileData(d1, fileId);

      const { chunks, edges } = await produceChunks({
        repoId,
        fileId,
        path: entry.path,
        language,
        content,
        commitSha,
      });
      if (chunks.length === 0) {
        filesIndexed++;
        continue;
      }

      redactChunks(chunks);
      await embedAndUpsert(ai, vectorize, job.repoFullName, chunks);
      await insertChunks(d1, chunks);
      await insertEdges(d1, edges);

      filesIndexed++;
      chunksWritten += chunks.length;
      edgesWritten += edges.length;

      await updateIndexStatus(d1, repoId, {
        status: 'INDEXING',
        indexedFiles: filesIndexed,
        totalChunks: chunksWritten,
        totalFiles: targets.length,
      });
    }

    await updateIndexStatus(d1, repoId, {
      status: 'READY',
      totalFiles: targets.length,
      indexedFiles: filesIndexed,
      totalChunks: chunksWritten,
      commitSha,
      finishing: true,
      error: null,
    });
    await setRepoStatus(d1, repoId, 'READY');

    log.info('indexing complete', {
      repo: job.repoFullName,
      filesIndexed,
      chunksWritten,
      edgesWritten,
      filesRemoved,
    });

    return {
      repoFullName: job.repoFullName,
      commitSha,
      filesIndexed,
      chunksWritten,
      edgesWritten,
      filesRemoved,
    };
  } catch (err) {
    const message = (err as Error).message;
    await updateIndexStatus(d1, repoId, {
      status: 'FAILED',
      error: message,
      finishing: true,
    }).catch(() => undefined);
    await setRepoStatus(d1, repoId, 'FAILED').catch(() => undefined);
    log.error('indexing failed', { repo: job.repoFullName, error: message });
    throw err;
  }
}

function selectTargets(
  job: IndexJob,
  tree: TreeEntry[],
  byPath: Map<string, TreeEntry>,
): { targets: TreeEntry[]; removed: string[] } {
  if (job.jobType === 'INCREMENTAL_INDEX') {
    const targets: TreeEntry[] = [];
    for (const path of job.changedFiles) {
      const entry = byPath.get(path);
      if (entry && shouldIndexFile(path, entry.size).include) targets.push(entry);
    }
    return { targets, removed: job.removedFiles };
  }
  const targets = tree.filter((e) => shouldIndexFile(e.path, e.size).include);
  return { targets, removed: [] };
}

interface ProduceInput {
  repoId: string;
  fileId: string;
  path: string;
  language: string | null;
  content: string;
  commitSha: string | null;
}

async function produceChunks(
  input: ProduceInput,
): Promise<{ chunks: CodeChunk[]; edges: import('@scintel/shared').CodeEdge[] }> {
  if (canTreeSit(input.path, input.language)) {
    const result = await chunkCode(input);
    if (result) return result;
  }
  if (isMarkdown(input.language)) {
    return { chunks: await chunkMarkdown(input), edges: [] };
  }
  if (input.language !== null) {
    return { chunks: await chunkGeneric(input), edges: [] };
  }
  return { chunks: [], edges: [] };
}

function redactChunks(chunks: CodeChunk[]): void {
  for (const chunk of chunks) {
    if (scanForSecrets(chunk.content).hasSecret) {
      const { redacted } = redactSecrets(chunk.content);
      chunk.content = redacted;
      chunk.redacted = true;
    }
  }
}

async function embedAndUpsert(
  ai: WorkersAIClient,
  vectorize: VectorizeClient,
  repoFullName: string,
  chunks: CodeChunk[],
): Promise<void> {
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const texts = batch.map((c) =>
      buildEmbeddingText({
        repoFullName,
        path: c.path,
        language: c.language,
        chunkType: c.chunkType,
        symbol: c.symbol,
        imports: c.imports,
        calls: c.calls,
        content: c.content,
      }),
    );
    const vectors = await ai.embed(texts);
    const upserts: UpsertVector[] = batch.map((c, idx) => ({
      id: c.id,
      values: vectors[idx] ?? [],
      metadata: toMetadata(repoFullName, c),
    }));
    await vectorize.upsert(upserts.filter((v) => v.values.length > 0));
  }
}

function toMetadata(repoFullName: string, c: CodeChunk): VectorMetadata {
  return {
    repo_id: c.repoId,
    repo_full_name: repoFullName,
    path: c.path,
    language: c.language ?? '',
    chunk_type: c.chunkType,
    symbol: c.symbol ?? '',
    start_line: c.startLine,
    end_line: c.endLine,
    commit_sha: c.commitSha ?? '',
  };
}
