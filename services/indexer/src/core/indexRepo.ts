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
  parseRepoRef,
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
  getRepoIndexInfo,
  updateIndexStatus,
  upsertFile,
  chunkIdsForFile,
  chunkHashesForFile,
  getFileContentHashes,
  deleteChunksByIds,
  deleteEdgesForFile,
  deleteFileData,
  deleteFileRow,
  insertChunks,
  insertEdges,
  countChunksForRepo,
  fileIdFor,
} from './store.js';
import { log } from '../logger.js';

const EMBED_BATCH = 50;
const FILE_CONCURRENCY = 6;
const EMBED_IN_FLIGHT = 2;
const STATUS_UPDATE_INTERVAL = 25;

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
  const github = await GitHubClient.fromConfig(config, job.installationId);
  const d1 = new D1Client(config);
  const vectorize = new VectorizeClient(config);
  const ai = new WorkersAIClient(config);

  const repo = parseRepoRef(job.repoFullName);
  if (!repo) {
    throw new Error(`invalid repo full name: ${job.repoFullName}`);
  }
  const repoId = repo.id;

  const repoInfo = await github.getRepo(repo.owner, repo.name);
  const commitSha =
    job.commitSha ??
    (await github.getBranchHeadSha(repo.owner, repo.name, repoInfo.default_branch));

  await ensureRepoRow(
    d1,
    job.repoFullName,
    repoInfo.default_branch,
    repoInfo.private,
    repoInfo.id,
  );

  const force = job.jobType === 'FULL_INDEX' && job.force === true;
  const prior = await getRepoIndexInfo(d1, repoId);

  // Up-to-date shortcut: a non-forced FULL_INDEX of an already-READY repo at
  // the same commit is a no-op (e.g. App reinstalls, duplicate triggers).
  if (
    !force &&
    job.jobType === 'FULL_INDEX' &&
    prior?.status === 'READY' &&
    prior.lastIndexedSha === commitSha
  ) {
    await updateIndexStatus(d1, repoId, {
      status: 'READY',
      jobType: job.jobType,
      commitSha,
      finishing: true,
      error: null,
    });
    await setRepoStatus(d1, repoId, 'READY', commitSha);
    log.info('repo already indexed at this commit; skipping', {
      repo: job.repoFullName,
      commitSha,
    });
    return {
      repoFullName: job.repoFullName,
      commitSha,
      filesIndexed: 0,
      chunksWritten: 0,
      edgesWritten: 0,
      filesRemoved: 0,
    };
  }

  let effectiveJob: IndexJob = job;

  // Escalation: an INCREMENTAL job for a repo identity that has never been
  // indexed (no last_indexed_sha — e.g. first push after a repo rename or a
  // brand-new repo) must become a FULL_INDEX. Indexing only the changed files
  // would mark the repo READY while most of it is missing.
  if (job.jobType === 'INCREMENTAL_INDEX' && !prior?.lastIndexedSha) {
    effectiveJob = {
      jobType: 'FULL_INDEX',
      repoId,
      repoFullName: job.repoFullName,
      commitSha,
      enqueuedAt: job.enqueuedAt,
    };
    log.info('incremental on never-indexed repo; escalating to full index', {
      repo: job.repoFullName,
    });
  }

  // Diff conversion: a non-forced FULL_INDEX of a previously indexed repo
  // only needs the files that changed since the last indexed commit.
  if (
    !force &&
    job.jobType === 'FULL_INDEX' &&
    prior?.lastIndexedSha &&
    prior.lastIndexedSha !== commitSha
  ) {
    const diff = await github
      .compareCommits(repo.owner, repo.name, prior.lastIndexedSha, commitSha)
      .catch(() => null);
    if (diff) {
      effectiveJob = {
        jobType: 'INCREMENTAL_INDEX',
        repoId,
        repoFullName: job.repoFullName,
        commitSha,
        changedFiles: diff.changed,
        removedFiles: diff.removed,
        enqueuedAt: job.enqueuedAt,
      };
      log.info('full index converted to diff-based incremental', {
        repo: job.repoFullName,
        base: prior.lastIndexedSha,
        changed: diff.changed.length,
        removed: diff.removed.length,
      });
    }
  }

  await setRepoStatus(d1, repoId, 'INDEXING');
  await updateIndexStatus(d1, repoId, {
    status: 'INDEXING',
    jobType: job.jobType,
    commitSha,
    starting: true,
    error: null,
  });

  try {
    const tree = await github.getTree(repo.owner, repo.name, commitSha);
    const byPath = new Map<string, TreeEntry>();
    for (const entry of tree) byPath.set(entry.path, entry);

    const { targets, removed } = selectTargets(effectiveJob, tree, byPath);

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

    const tarball =
      targets.length > 0
        ? await github.downloadTarball(repo.owner, repo.name, commitSha)
        : new Map<string, string>();
    const priorHashes = await getFileContentHashes(
      d1,
      targets.map((e) => fileIdFor(repoId, e.path)),
    );

    const progress = { filesIndexed: 0, chunksWritten: 0 };

    const fileStats = await mapPool(targets, FILE_CONCURRENCY, async (entry) => {
      const stat = await indexOneFile({
        d1,
        vectorize,
        ai,
        github,
        owner: repo.owner,
        name: repo.name,
        repoId,
        repoFullName: job.repoFullName,
        commitSha,
        force,
        entry,
        tarball,
        priorHashes,
        tenantId: job.tenantId,
      });
      if (stat.indexed) progress.filesIndexed++;
      progress.chunksWritten += stat.chunksWritten;
      const n = progress.filesIndexed;
      if (n % STATUS_UPDATE_INTERVAL === 0) {
        await updateIndexStatus(d1, repoId, {
          status: 'INDEXING',
          indexedFiles: n,
          totalChunks: progress.chunksWritten,
          totalFiles: targets.length,
        });
      }
      return stat;
    });

    for (const stat of fileStats) {
      if (stat.indexed) filesIndexed++;
      chunksWritten += stat.chunksWritten;
      edgesWritten += stat.edgesWritten;
    }

    if (filesIndexed > 0 && filesIndexed % STATUS_UPDATE_INTERVAL !== 0) {
      await updateIndexStatus(d1, repoId, {
        status: 'INDEXING',
        indexedFiles: filesIndexed,
        totalChunks: chunksWritten,
        totalFiles: targets.length,
      });
    }

    // Report the repo's true chunk total, not just this job's writes.
    const totalChunks = await countChunksForRepo(d1, repoId);
    await updateIndexStatus(d1, repoId, {
      status: 'READY',
      totalFiles: targets.length,
      indexedFiles: filesIndexed,
      totalChunks,
      commitSha,
      finishing: true,
      error: null,
    });
    await setRepoStatus(d1, repoId, 'READY', commitSha);

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

interface FileIndexStat {
  indexed: boolean;
  chunksWritten: number;
  edgesWritten: number;
}

interface IndexOneFileInput {
  d1: D1Client;
  vectorize: VectorizeClient;
  ai: WorkersAIClient;
  github: GitHubClient;
  owner: string;
  name: string;
  repoId: string;
  repoFullName: string;
  commitSha: string;
  force: boolean;
  entry: TreeEntry;
  tarball: Map<string, string>;
  priorHashes: Map<string, string>;
  tenantId?: string;
}

async function indexOneFile(input: IndexOneFileInput): Promise<FileIndexStat> {
  const { d1, vectorize, ai, repoId, repoFullName, commitSha, force, entry, tarball, priorHashes } =
    input;
  const fileId = fileIdFor(repoId, entry.path);
  const language = detectLanguage(entry.path);

  // Tarball is the fast path; fall back to the blob API for any path the tar
  // parser failed to surface so no tree entry is ever silently dropped.
  let raw = tarball.get(entry.path);
  if (raw === undefined) {
    log.warn('file missing from tarball; falling back to blob API', {
      repo: repoFullName,
      path: entry.path,
    });
    raw =
      (await input.github.getBlobContent(input.owner, input.name, entry.sha)) ??
      undefined;
  }
  if (raw === undefined || looksBinary(raw)) {
    return { indexed: false, chunksWritten: 0, edgesWritten: 0 };
  }
  const content = raw;
  const fileHash = await sha256Hex(content);

  if (!force) {
    const priorHash = priorHashes.get(fileId);
    if (priorHash === fileHash) {
      return { indexed: true, chunksWritten: 0, edgesWritten: 0 };
    }
  }

  await upsertFile(d1, {
    repoId,
    path: entry.path,
    language,
    sizeBytes: entry.size ?? content.length,
    contentHash: fileHash,
    commitSha,
  });

  const { chunks, edges } = await produceChunks({
    repoId,
    fileId,
    path: entry.path,
    language,
    content,
    commitSha,
  });
  redactChunks(chunks);

  let chunksWritten = 0;

  if (force) {
    const oldIds = await chunkIdsForFile(d1, fileId);
    if (oldIds.length) await vectorize.deleteByIds(oldIds);
    await deleteFileData(d1, fileId);
        await embedAndUpsert(ai, vectorize, repoFullName, chunks, input.tenantId);
    await insertChunks(d1, chunks);
    await insertEdges(d1, edges);
    chunksWritten = chunks.length;
  } else {
    const existing = await chunkHashesForFile(d1, fileId);
    const newIds = new Set(chunks.map((c) => c.id));
    const staleIds = [...existing.keys()].filter((id) => !newIds.has(id));
    const dirty = chunks.filter((c) => existing.get(c.id) !== c.contentHash);

    if (staleIds.length) {
      await vectorize.deleteByIds(staleIds);
      await deleteChunksByIds(d1, staleIds);
    }
    await deleteEdgesForFile(d1, fileId);
    await insertEdges(d1, edges);

    await embedAndUpsert(ai, vectorize, repoFullName, dirty, input.tenantId);
    await insertChunks(d1, dirty);
    chunksWritten = dirty.length;
  }

  return { indexed: true, chunksWritten, edgesWritten: edges.length };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
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
  tenantId?: string,
): Promise<void> {
  const batches: CodeChunk[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    batches.push(chunks.slice(i, i + EMBED_BATCH));
  }
  if (batches.length === 0) return;

  let next = 0;
  const workers = Array.from(
    { length: Math.min(EMBED_IN_FLIGHT, batches.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= batches.length) return;
        const batch = batches[i]!;
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
          metadata: toMetadata(repoFullName, c, tenantId),
        }));
        await vectorize.upsert(upserts.filter((v) => v.values.length > 0));
      }
    },
  );
  await Promise.all(workers);
}

function toMetadata(repoFullName: string, c: CodeChunk, tenantId?: string): VectorMetadata {
  return {
    ...(tenantId ? { tenant_id: tenantId } : {}),
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
