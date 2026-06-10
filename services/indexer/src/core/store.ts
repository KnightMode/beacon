/**
 * D1 write helpers for the indexer (via the D1 REST client). Handles file /
 * chunk / edge persistence and the repo index-status lifecycle.
 */

import {
  type CodeChunk,
  type CodeEdge,
  type IndexStatus,
} from '@scintel/shared';
import type { D1Client } from '../cloudflare/d1.js';

export function repoIdFor(fullName: string): string {
  return fullName.toLowerCase();
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
  const [owner, name] = fullName.split('/');
  const id = repoIdFor(fullName);
  await d1.exec(
    `INSERT INTO repos (id, github_id, full_name, owner, name, default_branch, private, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_id = COALESCE(excluded.github_id, repos.github_id),
       default_branch = excluded.default_branch,
       private = excluded.private,
       updated_at = datetime('now')`,
    [id, githubId, fullName, owner ?? '', name ?? '', defaultBranch, isPrivate ? 1 : 0],
  );
  return id;
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

export async function upsertFile(
  d1: D1Client,
  file: {
    repoId: string;
    path: string;
    language: string | null;
    sizeBytes: number | null;
    contentHash: string;
    commitSha: string | null;
  },
): Promise<string> {
  const id = fileIdFor(file.repoId, file.path);
  await d1.exec(
    `INSERT INTO files (id, repo_id, path, language, size_bytes, content_hash, commit_sha, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       language = excluded.language,
       size_bytes = excluded.size_bytes,
       content_hash = excluded.content_hash,
       commit_sha = excluded.commit_sha,
       updated_at = datetime('now')`,
    [id, file.repoId, file.path, file.language, file.sizeBytes, file.contentHash, file.commitSha],
  );
  return id;
}

/** Returns existing chunk ids for a file (used to also delete their vectors). */
export async function chunkIdsForFile(
  d1: D1Client,
  fileId: string,
): Promise<string[]> {
  const rows = await d1.query<{ id: string }>(
    `SELECT id FROM chunks WHERE file_id = ?1`,
    [fileId],
  );
  return rows.map((r) => r.id);
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

export async function deleteChunksByIds(
  d1: D1Client,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    await d1.exec(`DELETE FROM chunks WHERE id = ?1`, [id]);
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

export async function deleteFileRow(d1: D1Client, fileId: string): Promise<void> {
  await d1.exec(`DELETE FROM files WHERE id = ?1`, [fileId]);
}

export async function insertChunks(
  d1: D1Client,
  chunks: CodeChunk[],
): Promise<void> {
  for (const c of chunks) {
    await d1.exec(
      `INSERT INTO chunks
         (id, repo_id, file_id, path, language, chunk_type, symbol, start_line, end_line, content, content_hash, commit_sha, embedded, redacted)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         content_hash = excluded.content_hash,
         commit_sha = excluded.commit_sha,
         embedded = 1,
         redacted = excluded.redacted`,
      [
        c.id, c.repoId, c.fileId, c.path, c.language, c.chunkType, c.symbol,
        c.startLine, c.endLine, c.content, c.contentHash, c.commitSha,
        c.redacted ? 1 : 0,
      ],
    );
  }
}

export async function insertEdges(
  d1: D1Client,
  edges: CodeEdge[],
): Promise<void> {
  for (const e of edges) {
    await d1.exec(
      `INSERT INTO code_edges
         (id, repo_id, edge_type, from_node_id, to_node_id, from_symbol, to_symbol, file_id, start_line)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO NOTHING`,
      [
        e.id, e.repoId, e.edgeType, e.fromNodeId, e.toNodeId,
        e.fromSymbol, e.toSymbol, e.fileId, e.startLine,
      ],
    );
  }
}
