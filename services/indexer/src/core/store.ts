/**
 * D1 write helpers for the indexer (via the D1 REST client). Handles file /
 * chunk / edge persistence and the repo index-status lifecycle.
 */

import {
  type CodeChunk,
  type CodeEdge,
  type CodeIndexArtifact,
  type IndexStatus,
  type ScipReference,
  type ScipSymbol,
  parseRepoRef,
  repoIdFor as sharedRepoIdFor,
} from '@scintel/shared';
import type { D1Client } from '../cloudflare/d1.js';

export function repoIdFor(fullName: string): string {
  return sharedRepoIdFor(fullName);
}

export function fileIdFor(repoId: string, path: string): string {
  return `${repoId}:${path}`;
}

export async function ensureRepoRow(
  d1: D1Client,
  fullName: string,
  defaultBranch: string,
  isPrivate: boolean,
  githubId: number | null,
): Promise<string> {
  const parsed = parseRepoRef(fullName);
  if (!parsed) throw new Error(`Invalid GitHub repository: ${fullName}`);
  await d1.exec(
    `INSERT INTO repos (id, github_id, full_name, owner, name, default_branch, private, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_id = COALESCE(excluded.github_id, repos.github_id),
       default_branch = excluded.default_branch,
       private = excluded.private,
       updated_at = datetime('now')`,
    [
      parsed.id,
      githubId,
      parsed.fullName,
      parsed.owner,
      parsed.name,
      defaultBranch,
      isPrivate ? 1 : 0,
    ],
  );
  return parsed.id;
}

export async function setRepoStatus(
  d1: D1Client,
  repoId: string,
  status: IndexStatus,
  indexedSha?: string,
): Promise<void> {
  await d1.exec(
    `UPDATE repos SET indexing_status = ?2,
       last_indexed_at = CASE WHEN ?2 = 'READY' THEN datetime('now') ELSE last_indexed_at END,
       last_indexed_sha = COALESCE(?3, last_indexed_sha),
       updated_at = datetime('now')
     WHERE id = ?1`,
    [repoId, status, indexedSha ?? null],
  );
}

export async function getRepoIndexInfo(
  d1: D1Client,
  repoId: string,
): Promise<{ lastIndexedSha: string | null; status: string } | null> {
  const rows = await d1.query<{
    last_indexed_sha: string | null;
    indexing_status: string;
  }>(`SELECT last_indexed_sha, indexing_status FROM repos WHERE id = ?1`, [
    repoId,
  ]);
  const row = rows[0];
  return row
    ? { lastIndexedSha: row.last_indexed_sha, status: row.indexing_status }
    : null;
}

export interface IndexStatusUpdate {
  status: IndexStatus;
  jobType?: string;
  totalFiles?: number;
  indexedFiles?: number;
  totalChunks?: number;
  commitSha?: string;
  error?: string | null;
  starting?: boolean;
  finishing?: boolean;
}

export async function updateIndexStatus(
  d1: D1Client,
  repoId: string,
  u: IndexStatusUpdate,
): Promise<void> {
  await d1.exec(
    `INSERT INTO repo_index_status
       (repo_id, status, job_type, total_files, indexed_files, total_chunks, commit_sha, error, started_at, finished_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
       CASE WHEN ?9 = 1 THEN datetime('now') ELSE NULL END,
       CASE WHEN ?10 = 1 THEN datetime('now') ELSE NULL END,
       datetime('now'))
     ON CONFLICT(repo_id) DO UPDATE SET
       status = excluded.status,
       job_type = COALESCE(excluded.job_type, repo_index_status.job_type),
       total_files = COALESCE(excluded.total_files, repo_index_status.total_files),
       indexed_files = COALESCE(excluded.indexed_files, repo_index_status.indexed_files),
       total_chunks = COALESCE(excluded.total_chunks, repo_index_status.total_chunks),
       commit_sha = COALESCE(excluded.commit_sha, repo_index_status.commit_sha),
       error = excluded.error,
       started_at = CASE WHEN ?9 = 1 THEN datetime('now') ELSE repo_index_status.started_at END,
       finished_at = CASE WHEN ?10 = 1 THEN datetime('now') ELSE repo_index_status.finished_at END,
       updated_at = datetime('now')`,
    [
      repoId,
      u.status,
      u.jobType ?? null,
      u.totalFiles ?? null,
      u.indexedFiles ?? null,
      u.totalChunks ?? null,
      u.commitSha ?? null,
      u.error ?? null,
      u.starting ? 1 : 0,
      u.finishing ? 1 : 0,
    ],
  );
}

export interface FileRow {
  repoId: string;
  path: string;
  language: string | null;
  sizeBytes: number | null;
  contentHash: string;
  gitBlobSha: string | null;
  commitSha: string | null;
}

/** Existing chunk id -> content_hash map for a file (unchanged-chunk skip). */
export async function chunkHashesForFile(
  d1: D1Client,
  fileId: string,
): Promise<Map<string, string>> {
  const rows = await d1.query<{ id: string; content_hash: string }>(
    `SELECT id, content_hash FROM chunks WHERE file_id = ?1`,
    [fileId],
  );
  return new Map(rows.map((r) => [r.id, r.content_hash]));
}

/** Batch lookup of chunk id -> content_hash per file (one query per file-id batch). */
export async function getChunkHashesForFiles(
  d1: D1Client,
  fileIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const BATCH = 100;
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const rows = await d1.query<{
      file_id: string;
      id: string;
      content_hash: string;
    }>(
      `SELECT file_id, id, content_hash FROM chunks WHERE file_id IN (${placeholders})`,
      batch,
    );
    for (const row of rows) {
      let fileMap = out.get(row.file_id);
      if (!fileMap) {
        fileMap = new Map();
        out.set(row.file_id, fileMap);
      }
      fileMap.set(row.id, row.content_hash);
    }
  }
  return out;
}

/** Batch lookup of chunk ids per file (for vector deletes on force reindex). */
export async function getChunkIdsForFiles(
  d1: D1Client,
  fileIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const BATCH = 100;
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const rows = await d1.query<{ file_id: string; id: string }>(
      `SELECT file_id, id FROM chunks WHERE file_id IN (${placeholders})`,
      batch,
    );
    for (const row of rows) {
      const ids = out.get(row.file_id);
      if (ids) ids.push(row.id);
      else out.set(row.file_id, [row.id]);
    }
  }
  return out;
}

/** Stored content hash of a file row, if any (unchanged-file skip). */
export async function getFileContentHash(
  d1: D1Client,
  fileId: string,
): Promise<string | null> {
  const rows = await d1.query<{ content_hash: string | null }>(
    `SELECT content_hash FROM files WHERE id = ?1`,
    [fileId],
  );
  return rows[0]?.content_hash ?? null;
}

/** Batch lookup of stored Git blob SHAs (one query per batch). */
export async function getFileBlobShas(
  d1: D1Client,
  fileIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const BATCH = 100;
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const rows = await d1.query<{ id: string; git_blob_sha: string | null }>(
      `SELECT id, git_blob_sha FROM files WHERE id IN (${placeholders})`,
      batch,
    );
    for (const row of rows) {
      if (row.git_blob_sha) out.set(row.id, row.git_blob_sha);
    }
  }
  return out;
}

/** Batch lookup of stored content hashes (one query per batch). */
export async function getFileContentHashes(
  d1: D1Client,
  fileIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // D1 caps bound parameters at 100 per query (error 7500 above that).
  const BATCH = 100;
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const rows = await d1.query<{ id: string; content_hash: string | null }>(
      `SELECT id, content_hash FROM files WHERE id IN (${placeholders})`,
      batch,
    );
    for (const row of rows) {
      if (row.content_hash) out.set(row.id, row.content_hash);
    }
  }
  return out;
}

export async function deleteChunksByIds(
  d1: D1Client,
  ids: string[],
): Promise<void> {
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    await d1.exec(`DELETE FROM chunks WHERE id IN (${placeholders})`, batch);
  }
}

export async function deleteEdgesForFile(
  d1: D1Client,
  fileId: string,
): Promise<void> {
  await d1.exec(`DELETE FROM code_edges WHERE file_id = ?1`, [fileId]);
}

export async function countChunksForRepo(
  d1: D1Client,
  repoId: string,
): Promise<number> {
  const rows = await d1.query<{ n: number }>(
    `SELECT count(*) AS n FROM chunks WHERE repo_id = ?1`,
    [repoId],
  );
  return rows[0]?.n ?? 0;
}

export async function deleteFileData(d1: D1Client, fileId: string): Promise<void> {
  await d1.exec(`DELETE FROM code_edges WHERE file_id = ?1`, [fileId]);
  await d1.exec(`DELETE FROM chunks WHERE file_id = ?1`, [fileId]);
}

/** Batched delete of code_edges for many files (removed-files cleanup). */
export async function deleteEdgesByFileIds(
  d1: D1Client,
  fileIds: string[],
): Promise<void> {
  const BATCH = 100;
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    await d1.exec(`DELETE FROM code_edges WHERE file_id IN (${placeholders})`, batch);
  }
}

/** Batched delete of chunks for many files (removed-files cleanup). */
export async function deleteChunksByFileIds(
  d1: D1Client,
  fileIds: string[],
): Promise<void> {
  const BATCH = 100;
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    await d1.exec(`DELETE FROM chunks WHERE file_id IN (${placeholders})`, batch);
  }
}

/** Batched delete of file rows by id (removed-files cleanup). */
export async function deleteFilesByIds(
  d1: D1Client,
  ids: string[],
): Promise<void> {
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    await d1.exec(`DELETE FROM files WHERE id IN (${placeholders})`, batch);
  }
}

const FILE_UPSERT_ROW_PARAMS = 8;
// D1 caps bound parameters at 100 per query.
const FILE_UPSERT_BATCH = Math.floor(100 / FILE_UPSERT_ROW_PARAMS);
const FILE_VALUE_ROW = "(?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))";

function fileUpsertParams(f: FileRow): unknown[] {
  return [
    fileIdFor(f.repoId, f.path),
    f.repoId,
    f.path,
    f.language,
    f.sizeBytes,
    f.contentHash,
    f.gitBlobSha,
    f.commitSha,
  ];
}

/**
 * Batched file-row upsert. Callers must only invoke this after the file's
 * chunks have been durably written (embedded + inserted) — persisting
 * git_blob_sha/content_hash first would make a retry after a failed embed
 * blob-skip the file forever (see blobSkip.ts).
 */
export async function upsertFiles(d1: D1Client, rows: FileRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += FILE_UPSERT_BATCH) {
    const batch = rows.slice(i, i + FILE_UPSERT_BATCH);
    if (batch.length === 0) continue;
    const values = batch.map(() => FILE_VALUE_ROW).join(', ');
    await d1.exec(
      `INSERT INTO files (id, repo_id, path, language, size_bytes, content_hash, git_blob_sha, commit_sha, updated_at)
       VALUES ${values}
       ON CONFLICT(id) DO UPDATE SET
         language = excluded.language,
         size_bytes = excluded.size_bytes,
         content_hash = excluded.content_hash,
         git_blob_sha = excluded.git_blob_sha,
         commit_sha = excluded.commit_sha,
         updated_at = datetime('now')`,
      batch.flatMap((f) => fileUpsertParams(f)),
    );
  }
}

const CHUNK_INSERT_ROW_PARAMS = 13;
// D1 caps bound parameters at 100 per query.
const CHUNK_INSERT_BATCH = Math.floor(100 / CHUNK_INSERT_ROW_PARAMS);
const CHUNK_VALUE_ROW =
  '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)';
const EDGE_INSERT_ROW_PARAMS = 9;
const EDGE_INSERT_BATCH = Math.floor(100 / EDGE_INSERT_ROW_PARAMS);

function chunkInsertParams(c: CodeChunk): unknown[] {
  return [
    c.id,
    c.repoId,
    c.fileId,
    c.path,
    c.language,
    c.chunkType,
    c.symbol,
    c.startLine,
    c.endLine,
    c.content,
    c.contentHash,
    c.commitSha,
    c.redacted ? 1 : 0,
  ];
}

function edgeInsertParams(e: CodeEdge): unknown[] {
  return [
    e.id,
    e.repoId,
    e.edgeType,
    e.fromNodeId,
    e.toNodeId,
    e.fromSymbol,
    e.toSymbol,
    e.fileId,
    e.startLine,
  ];
}

export async function insertChunks(
  d1: D1Client,
  chunks: CodeChunk[],
): Promise<void> {
  for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
    const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH);
    if (batch.length === 0) continue;
    const values = batch.map(() => CHUNK_VALUE_ROW).join(', ');
    await d1.exec(
      `INSERT INTO chunks
         (id, repo_id, file_id, path, language, chunk_type, symbol, start_line, end_line, content, content_hash, commit_sha, embedded, redacted)
       VALUES ${values}
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         content_hash = excluded.content_hash,
         commit_sha = excluded.commit_sha,
         embedded = 1,
         redacted = excluded.redacted`,
      batch.flatMap((c) => chunkInsertParams(c)),
    );
  }
}

export async function insertEdges(
  d1: D1Client,
  edges: CodeEdge[],
): Promise<void> {
  for (let i = 0; i < edges.length; i += EDGE_INSERT_BATCH) {
    const batch = edges.slice(i, i + EDGE_INSERT_BATCH);
    if (batch.length === 0) continue;
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    await d1.exec(
      `INSERT INTO code_edges
         (id, repo_id, edge_type, from_node_id, to_node_id, from_symbol, to_symbol, file_id, start_line)
       VALUES ${values}
       ON CONFLICT(id) DO NOTHING`,
      batch.flatMap((e) => edgeInsertParams(e)),
    );
  }
}

export async function upsertCodeIndexArtifact(
  d1: D1Client,
  artifact: CodeIndexArtifact,
): Promise<void> {
  await d1.exec(
    `INSERT INTO code_index_artifacts
       (id, repo_id, artifact_type, status, commit_sha, language, producer,
        artifact_uri, content_hash, metadata_json, error, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       artifact_uri = excluded.artifact_uri,
       content_hash = excluded.content_hash,
       metadata_json = excluded.metadata_json,
       error = excluded.error,
       updated_at = datetime('now')`,
    [
      artifact.id,
      artifact.repoId,
      artifact.artifactType,
      artifact.status,
      artifact.commitSha,
      artifact.language ?? '',
      artifact.producer,
      artifact.artifactUri,
      artifact.contentHash,
      artifact.metadataJson,
      artifact.error,
    ],
  );
}

const SCIP_SYMBOL_INSERT_ROW_PARAMS = 11;
// D1 caps bound parameters at 100 per query.
const SCIP_SYMBOL_INSERT_BATCH = Math.floor(100 / SCIP_SYMBOL_INSERT_ROW_PARAMS);
const SCIP_SYMBOL_VALUE_ROW = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))";
const SCIP_REFERENCE_INSERT_ROW_PARAMS = 9;
const SCIP_REFERENCE_INSERT_BATCH = Math.floor(100 / SCIP_REFERENCE_INSERT_ROW_PARAMS);
const SCIP_REFERENCE_VALUE_ROW = '(?, ?, ?, ?, ?, ?, ?, ?, ?)';

function scipSymbolInsertParams(s: ScipSymbol): unknown[] {
  return [
    s.id,
    s.repoId,
    s.symbol,
    s.displayName,
    s.kind,
    s.language,
    s.path,
    s.startLine,
    s.endLine,
    s.definitionChunkId,
    s.commitSha,
  ];
}

function scipReferenceInsertParams(r: ScipReference): unknown[] {
  return [
    r.id,
    r.repoId,
    r.symbolId,
    r.role,
    r.path,
    r.startLine,
    r.endLine,
    r.enclosingSymbol,
    r.commitSha,
  ];
}

export async function replaceScipFactsForRepo(
  d1: D1Client,
  repoId: string,
  symbols: ScipSymbol[],
  references: ScipReference[],
): Promise<void> {
  await d1.exec(`DELETE FROM scip_references WHERE repo_id = ?1`, [repoId]);
  await d1.exec(`DELETE FROM scip_symbols WHERE repo_id = ?1`, [repoId]);

  for (let i = 0; i < symbols.length; i += SCIP_SYMBOL_INSERT_BATCH) {
    const batch = symbols.slice(i, i + SCIP_SYMBOL_INSERT_BATCH);
    if (batch.length === 0) continue;
    const values = batch.map(() => SCIP_SYMBOL_VALUE_ROW).join(', ');
    await d1.exec(
      `INSERT INTO scip_symbols
         (id, repo_id, symbol, display_name, kind, language, path, start_line,
          end_line, definition_chunk_id, commit_sha, updated_at)
       VALUES ${values}
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         kind = excluded.kind,
         language = excluded.language,
         path = excluded.path,
         start_line = excluded.start_line,
         end_line = excluded.end_line,
         definition_chunk_id = excluded.definition_chunk_id,
         commit_sha = excluded.commit_sha,
         updated_at = datetime('now')`,
      batch.flatMap((s) => scipSymbolInsertParams(s)),
    );
  }

  for (let i = 0; i < references.length; i += SCIP_REFERENCE_INSERT_BATCH) {
    const batch = references.slice(i, i + SCIP_REFERENCE_INSERT_BATCH);
    if (batch.length === 0) continue;
    const values = batch.map(() => SCIP_REFERENCE_VALUE_ROW).join(', ');
    await d1.exec(
      `INSERT INTO scip_references
         (id, repo_id, symbol_id, role, path, start_line, end_line,
          enclosing_symbol, commit_sha)
       VALUES ${values}
       ON CONFLICT(id) DO NOTHING`,
      batch.flatMap((r) => scipReferenceInsertParams(r)),
    );
  }
}
