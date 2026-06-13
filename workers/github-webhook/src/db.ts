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

export async function hasLinkedTenants(
  env: Env,
  installationId: number | undefined,
): Promise<boolean> {
  if (!installationId) return false;
  const row = await env.DB.prepare(
    `SELECT tenant_id FROM tenant_github_installations WHERE installation_id = ?1 LIMIT 1`,
  )
    .bind(installationId)
    .first();
  return row !== null;
}

export async function queuePendingInstallationRepo(
  env: Env,
  installationId: number | undefined,
  repoId: string,
  fullName: string,
): Promise<void> {
  if (!installationId) return;
  await env.DB.prepare(
    `INSERT INTO pending_installation_repos (installation_id, repo_id, full_name)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(installation_id, repo_id) DO UPDATE SET full_name = excluded.full_name`,
  )
    .bind(installationId, repoId, fullName)
    .run();
}

export async function addRepoToInstallationTenants(
  env: Env,
  installationId: number | undefined,
  repoId: string,
  fullName: string,
): Promise<void> {
  if (!installationId) return;
  const { results } = await env.DB.prepare(
    `SELECT tenant_id FROM tenant_github_installations WHERE installation_id = ?1`,
  )
    .bind(installationId)
    .all<{ tenant_id: string }>();
  for (const row of results) {
    await env.DB.prepare(
      `INSERT INTO tenant_repos (tenant_id, repo_id, full_name, enabled, selected_by, updated_at)
       VALUES (?1, ?2, ?3, 1, 'github-installation', datetime('now'))
       ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
         enabled = 1,
         full_name = excluded.full_name,
         updated_at = datetime('now')`,
    )
      .bind(row.tenant_id, repoId, fullName)
      .run();
    await env.DB.prepare(
      `DELETE FROM pending_installation_repos
       WHERE installation_id = ?1 AND repo_id = ?2`,
    )
      .bind(installationId, repoId)
      .run();
  }
}

/** Backfill tenant repos after the GitHub App install OAuth callback. */
export async function linkPendingInstallationRepos(
  env: Env,
  tenantId: string,
  installationId: number,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT repo_id, full_name FROM pending_installation_repos
     WHERE installation_id = ?1`,
  )
    .bind(installationId)
    .all<{ repo_id: string; full_name: string }>();

  for (const row of results) {
    await env.DB.prepare(
      `INSERT INTO tenant_repos (tenant_id, repo_id, full_name, enabled, selected_by, updated_at)
       VALUES (?1, ?2, ?3, 1, 'github-installation', datetime('now'))
       ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
         enabled = 1,
         full_name = excluded.full_name,
         updated_at = datetime('now')`,
    )
      .bind(tenantId, row.repo_id, row.full_name)
      .run();
    await env.DB.prepare(
      `DELETE FROM pending_installation_repos
       WHERE installation_id = ?1 AND repo_id = ?2`,
    )
      .bind(installationId, row.repo_id)
      .run();
  }
  return results.length;
}

export async function getSlackTeamIdsForRepo(
  env: Env,
  repoId: string,
): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT t.slack_team_id
     FROM tenants t
     JOIN tenant_repos tr ON tr.tenant_id = t.id
     JOIN tenant_ci_notify_channels nc
       ON nc.tenant_id = t.id AND nc.repo_id = tr.repo_id
     WHERE tr.repo_id = ?1
       AND tr.enabled = 1
       AND t.status = 'ACTIVE'
     ORDER BY t.slack_team_id`,
  )
    .bind(repoId)
    .all<{ slack_team_id: string }>();
  return results.map((row) => row.slack_team_id);
}

export async function isAllowlisted(env: Env, repoId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT repo_id FROM prototype_repo_allowlist WHERE repo_id = ?1 AND enabled = 1
     UNION ALL
     SELECT repo_id FROM tenant_repos WHERE repo_id = ?1 AND enabled = 1
     LIMIT 1`,
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
