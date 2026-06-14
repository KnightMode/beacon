/**
 * D1 helpers for the webhook worker: upserting repos, syncing tenant
 * installation grants, maintaining legacy allowlist entries, and tracking
 * index-status lifecycle.
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

export async function upsertInstallationRepoGrant(
  env: Env,
  installationId: number | undefined,
  repoId: string,
  repo: RepoUpsert,
): Promise<void> {
  if (!installationId) return;
  await env.DB.prepare(
    `INSERT INTO github_installation_repos
       (installation_id, repo_id, full_name, github_id, default_branch, private, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
     ON CONFLICT(installation_id, repo_id) DO UPDATE SET
       full_name = excluded.full_name,
       github_id = COALESCE(excluded.github_id, github_installation_repos.github_id),
       default_branch = excluded.default_branch,
       private = excluded.private,
       updated_at = datetime('now')`,
  )
    .bind(
      installationId,
      repoId,
      repo.fullName,
      repo.githubId ?? null,
      repo.defaultBranch ?? 'main',
      repo.private === false ? 0 : 1,
    )
    .run();
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
      `INSERT INTO tenant_repos (tenant_id, repo_id, installation_id, full_name, enabled, selected_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, 'github-installation', datetime('now'))
       ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
         enabled = 1,
         installation_id = excluded.installation_id,
         full_name = excluded.full_name,
         updated_at = datetime('now')`,
    )
      .bind(row.tenant_id, repoId, installationId, fullName)
      .run();
    await env.DB.prepare(
      `DELETE FROM pending_installation_repos
       WHERE installation_id = ?1 AND repo_id = ?2`,
    )
      .bind(installationId, repoId)
      .run();
  }
}

export async function revokeRepoFromInstallationTenants(
  env: Env,
  installationId: number | undefined,
  repoId: string,
): Promise<void> {
  if (!installationId) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tenant_repos
       SET enabled = 0, updated_at = datetime('now')
       WHERE repo_id = ?1
         AND installation_id = ?2
         AND tenant_id IN (
           SELECT tenant_id FROM tenant_github_installations
           WHERE installation_id = ?2
         )`,
    ).bind(repoId, installationId),
    env.DB.prepare(
      `DELETE FROM pending_installation_repos
       WHERE installation_id = ?1 AND repo_id = ?2`,
    ).bind(installationId, repoId),
    env.DB.prepare(
      `DELETE FROM github_installation_repos
       WHERE installation_id = ?1 AND repo_id = ?2`,
    ).bind(installationId, repoId),
  ]);
}

/** Disable an allowlist entry that was seeded from a GitHub App installation. */
export async function disableInstallationAllowlist(
  env: Env,
  repoId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE prototype_repo_allowlist SET enabled = 0
     WHERE repo_id = ?1 AND added_by = 'installation'`,
  )
    .bind(repoId)
    .run();
}

/** True when any tenant or allowlist entry still actively references the repo. */
export async function isRepoInUse(env: Env, repoId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM tenant_repos WHERE repo_id = ?1 AND enabled = 1
     UNION ALL
     SELECT 1 AS x FROM prototype_repo_allowlist WHERE repo_id = ?1 AND enabled = 1
     LIMIT 1`,
  )
    .bind(repoId)
    .first();
  return row !== null;
}

const VECTORIZE_DELETE_BATCH = 1000;

/**
 * Remove every trace of a repo's index from Cloudflare once it's orphaned
 * (no tenant or allowlist still references it). Chunk ids double as Vectorize
 * vector ids, so delete those vectors first, then drop the repo's D1 rows.
 * Chunks are deleted explicitly so the FTS5 sync triggers fire.
 */
export async function purgeRepoIndex(
  env: Env,
  repoId: string,
): Promise<{ vectors: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM chunks WHERE repo_id = ?1`,
  )
    .bind(repoId)
    .all<{ id: string }>();
  const ids = results.map((row) => row.id);

  for (let i = 0; i < ids.length; i += VECTORIZE_DELETE_BATCH) {
    const batch = ids.slice(i, i + VECTORIZE_DELETE_BATCH);
    if (batch.length) await env.VECTORIZE.deleteByIds(batch);
  }

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM chunks WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM code_edges WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM files WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM repo_index_status WHERE repo_id = ?1`).bind(repoId),
  ]);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM tenant_repos WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM tenant_ci_notify_channels WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM ci_notify_channels WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM prototype_repo_allowlist WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM pending_installation_repos WHERE repo_id = ?1`).bind(repoId),
    env.DB.prepare(`DELETE FROM repos WHERE id = ?1`).bind(repoId),
  ]);

  return { vectors: ids.length };
}

/** Backfill tenant repos after the GitHub App install OAuth callback. */
export async function linkPendingInstallationRepos(
  env: Env,
  tenantId: string,
  installationId: number,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT repo_id, full_name FROM github_installation_repos
     WHERE installation_id = ?1`,
  )
    .bind(installationId)
    .all<{ repo_id: string; full_name: string }>();
  const rows = results.length > 0
    ? results
    : (await env.DB.prepare(
        `SELECT repo_id, full_name FROM pending_installation_repos
         WHERE installation_id = ?1`,
      )
        .bind(installationId)
        .all<{ repo_id: string; full_name: string }>()).results;

  for (const row of rows) {
    await env.DB.prepare(
      `INSERT INTO tenant_repos (tenant_id, repo_id, installation_id, full_name, enabled, selected_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, 'github-installation', datetime('now'))
       ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
         enabled = 1,
         installation_id = excluded.installation_id,
         full_name = excluded.full_name,
         updated_at = datetime('now')`,
    )
      .bind(tenantId, row.repo_id, installationId, row.full_name)
      .run();
    await env.DB.prepare(
      `DELETE FROM pending_installation_repos
       WHERE installation_id = ?1 AND repo_id = ?2`,
    )
      .bind(installationId, row.repo_id)
      .run();
  }
  return rows.length;
}

export async function getTenantSelectionsForInstallationRepo(
  env: Env,
  installationId: number | undefined,
  repoId: string,
): Promise<Array<{ tenantId: string; installationId: number }>> {
  if (!installationId) return [];
  const { results } = await env.DB.prepare(
    `SELECT tr.tenant_id, tr.installation_id
     FROM tenant_repos tr
     JOIN tenants t ON t.id = tr.tenant_id
     WHERE tr.repo_id = ?1
       AND tr.installation_id = ?2
       AND tr.enabled = 1
       AND t.status = 'ACTIVE'
     ORDER BY tr.tenant_id`,
  )
    .bind(repoId, installationId)
    .all<{ tenant_id: string; installation_id: number }>();
  return results.map((row) => ({
    tenantId: row.tenant_id,
    installationId: row.installation_id,
  }));
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
