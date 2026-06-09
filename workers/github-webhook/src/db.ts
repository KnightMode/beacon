/**
 * D1 helpers for the webhook worker: upserting repos, seeding the allowlist,
 * and tracking index-status lifecycle.
 */

import { INDEX_STATUS, type IndexStatus } from '@scintel/shared';
import type { Env } from './env.js';

export interface RepoUpsert {
  githubId?: number | null;
  fullName: string;
  defaultBranch?: string;
  private?: boolean;
}

export function repoIdFor(fullName: string): string {
  return fullName.toLowerCase();
}

export async function upsertRepo(env: Env, repo: RepoUpsert): Promise<string> {
  const [owner, name] = repo.fullName.split('/');
  const id = repoIdFor(repo.fullName);
  await env.DB.prepare(
    `INSERT INTO repos (id, github_id, full_name, owner, name, default_branch, private, indexing_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_id = COALESCE(excluded.github_id, repos.github_id),
       default_branch = excluded.default_branch,
       private = excluded.private,
       updated_at = datetime('now')`,
  )
    .bind(
      id,
      repo.githubId ?? null,
      repo.fullName,
      owner ?? '',
      name ?? '',
      repo.defaultBranch ?? 'main',
      repo.private === false ? 0 : 1,
      INDEX_STATUS.PENDING,
    )
    .run();
  return id;
}

export async function addToAllowlist(
  env: Env,
  repoId: string,
  fullName: string,
  addedBy: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO prototype_repo_allowlist (repo_id, full_name, enabled, added_by)
     VALUES (?1, ?2, 1, ?3)
     ON CONFLICT(repo_id) DO UPDATE SET enabled = 1, full_name = excluded.full_name`,
  )
    .bind(repoId, fullName, addedBy)
    .run();
}

export async function isAllowlisted(env: Env, repoId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT repo_id FROM prototype_repo_allowlist WHERE repo_id = ?1 AND enabled = 1`,
  )
    .bind(repoId)
    .first();
  return row !== null;
}

export async function setIndexStatus(
  env: Env,
  repoId: string,
  status: IndexStatus,
  jobType?: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE repos SET indexing_status = ?2, updated_at = datetime('now') WHERE id = ?1`,
    ).bind(repoId, status),
    env.DB.prepare(
      `INSERT INTO repo_index_status (repo_id, status, job_type, started_at, updated_at)
       VALUES (?1, ?2, ?3, datetime('now'), datetime('now'))
       ON CONFLICT(repo_id) DO UPDATE SET
         status = excluded.status,
         job_type = COALESCE(excluded.job_type, repo_index_status.job_type),
         updated_at = datetime('now')`,
    ).bind(repoId, status, jobType ?? null),
  ]);
}
