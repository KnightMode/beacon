/**
 * Self-serve repo onboarding from Slack: "index owner/repo" validates the repo
 * with the tenant GitHub App installation, allowlists it in D1, and fires the
 * index.yml GitHub Actions workflow (repository_dispatch). "index status"
 * reports per-repo indexing progress from repo_index_status.
 */

import {
  createInstallationAccessToken,
  getInstallationIdForTenant,
} from '@scintel/shared';
import type { Env } from '../env.js';
import {
  getTenantIdForSlackTeam,
  tenantHasGithubInstallationRepo,
} from '../tenant.js';

const GITHUB_API = 'https://api.github.com';
const DISPATCH_EVENT = 'index-repo';
const ONBOARDING_REQUIRED =
  ':information_source: This workspace is not onboarded yet. Open the admin portal, ' +
  'connect Slack, then add repos there before indexing from chat.';

interface GithubRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}

/** Validates, allowlists, and kicks off indexing. Returns the Slack reply. */
export async function indexRepoAction(
  env: Env,
  repoRef: string,
  teamId?: string,
): Promise<string> {
  const dispatchRepo = env.INDEX_DISPATCH_REPO || env.DEFAULT_PR_REPO;
  const dispatchToken = env.PIPELINE_DISPATCH_TOKEN;
  if (!dispatchRepo || !dispatchToken) {
    return (
      ':warning: The indexing pipeline is not configured (`INDEX_DISPATCH_REPO` / ' +
      '`PIPELINE_DISPATCH_TOKEN`). Contact an administrator.'
    );
  }

  const tenantId = await getTenantIdForSlackTeam(env, teamId);
  if (teamId && !tenantId) {
    return ONBOARDING_REQUIRED;
  }

  let repo: GithubRepo;
  let installationId: number | undefined;

  try {
    if (tenantId) {
      installationId = (await getInstallationIdForTenant(env.DB, tenantId)) ?? undefined;
      if (!installationId) {
        return ':information_source: Connect GitHub in the admin portal before indexing repos.';
      }
      if (!(await tenantHasGithubInstallationRepo(env, tenantId, repoRef.toLowerCase()))) {
        return (
          `:no_entry: \`${repoRef}\` is not available on this workspace's ` +
          'GitHub App installation. Add it in the admin portal first, then try indexing again.'
        );
      }
      repo = await fetchRepoWithInstallation(env, installationId, repoRef);
    } else {
      if (!env.GITHUB_PAT) {
        return ':warning: `GITHUB_PAT` is not configured on the bot, so I cannot index repos.';
      }
      repo = await fetchRepoWithPat(env, repoRef);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `:no_entry: I can't access \`${repoRef}\` on GitHub (${message}).`;
  }

  const repoId = repo.full_name.toLowerCase();
  const [owner, name] = repo.full_name.split('/');

  // 2. Upsert the repo row, allowlist it, and mark indexing PENDING.
  await env.DB.prepare(
    `INSERT INTO repos (id, github_id, full_name, owner, name, default_branch, private, indexing_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PENDING', datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_id = excluded.github_id,
       default_branch = excluded.default_branch,
       private = excluded.private,
       updated_at = datetime('now')`,
  )
    .bind(repoId, repo.id, repo.full_name, owner ?? '', name ?? '', repo.default_branch, repo.private ? 1 : 0)
    .run();

  if (tenantId) {
    await env.DB.prepare(
      `INSERT INTO tenant_repos (tenant_id, repo_id, full_name, enabled, selected_by, updated_at)
       VALUES (?1, ?2, ?3, 1, 'slack-index-intent', datetime('now'))
       ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
         enabled = 1,
         full_name = excluded.full_name,
         updated_at = datetime('now')`,
    )
      .bind(tenantId, repoId, repo.full_name)
      .run();

    await markStep(env, tenantId, 'repos', 'COMPLETE');
    await markStep(env, tenantId, 'indexing', 'PENDING');
  } else {
    await env.DB.prepare(
      `INSERT INTO prototype_repo_allowlist (repo_id, full_name, enabled, added_by)
       VALUES (?1, ?2, 1, 'slack-index-intent')
       ON CONFLICT(repo_id) DO UPDATE SET enabled = 1, full_name = excluded.full_name`,
    )
      .bind(repoId, repo.full_name)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO repo_index_status (repo_id, status, job_type, updated_at)
     VALUES (?1, 'PENDING', 'FULL_INDEX', datetime('now'))
     ON CONFLICT(repo_id) DO UPDATE SET
       status = 'PENDING', job_type = 'FULL_INDEX', error = NULL, updated_at = datetime('now')`,
  )
    .bind(repoId)
    .run();

  // 3. Fire the GitHub Actions indexing pipeline.
  const dispatch = await fetch(`${GITHUB_API}/repos/${dispatchRepo}/dispatches`, {
    method: 'POST',
    headers: dispatchHeaders(dispatchToken),
    body: JSON.stringify({
      event_type: DISPATCH_EVENT,
      client_payload: {
        repo: repo.full_name,
        jobType: 'FULL_INDEX',
        installationId: installationId ?? null,
      },
    }),
  });
  if (!dispatch.ok) {
    const text = await dispatch.text().catch(() => '');
    return (
      `:warning: \`${repo.full_name}\` is allowlisted, but triggering the ` +
      `indexing pipeline failed (${dispatch.status}): ${text.slice(0, 200)}`
    );
  }

  return (
    `:hammer_and_wrench: Indexing *${repo.full_name}* (default branch ` +
    `\`${repo.default_branch}\`) — a full index is running via GitHub Actions ` +
    'and usually takes a few minutes. Say `index status` to check progress; ' +
    'once it shows READY you can ask questions about the repo.'
  );
}

interface StatusRow {
  full_name: string;
  status: string;
  indexed_files: number | null;
  total_files: number | null;
  total_chunks: number | null;
  finished_at: string | null;
  error: string | null;
}

/** Formats indexing status for every known repo. */
export async function indexStatusAction(
  env: Env,
  teamId?: string,
): Promise<string> {
  const tenantId = await getTenantIdForSlackTeam(env, teamId);
  if (teamId && !tenantId) {
    return ONBOARDING_REQUIRED;
  }

  const query = tenantId
    ? env.DB.prepare(
        `SELECT r.full_name, s.status, s.indexed_files, s.total_files,
                s.total_chunks, s.finished_at, s.error
         FROM repo_index_status s
         JOIN repos r ON r.id = s.repo_id
         JOIN tenant_repos tr ON tr.repo_id = r.id
         WHERE tr.tenant_id = ?1 AND tr.enabled = 1
         ORDER BY r.full_name`,
      ).bind(tenantId)
    : env.DB.prepare(
        `SELECT r.full_name, s.status, s.indexed_files, s.total_files,
                s.total_chunks, s.finished_at, s.error
         FROM repo_index_status s JOIN repos r ON r.id = s.repo_id
         ORDER BY r.full_name`,
      );
  const { results } = await query.all<StatusRow>();

  if (results.length === 0) {
    return 'No repos are indexed yet. Say `index owner/repo` to add one.';
  }

  const lines = results.map((s) => {
    const icon =
      s.status === 'READY' ? ':white_check_mark:' :
      s.status === 'FAILED' ? ':x:' :
      s.status === 'INDEXING' ? ':hourglass_flowing_sand:' : ':clock3:';
    const progress =
      s.status === 'INDEXING'
        ? ` — ${s.indexed_files ?? 0}/${s.total_files ?? '?'} files`
        : s.status === 'READY'
          ? ` — ${s.total_chunks ?? 0} chunks`
          : '';
    const error = s.status === 'FAILED' && s.error ? ` (${s.error.slice(0, 120)})` : '';
    return `${icon} *${s.full_name}* — ${s.status}${progress}${error}`;
  });

  return lines.join('\n');
}

async function fetchRepoWithInstallation(
  env: Env,
  installationId: number,
  repoRef: string,
): Promise<GithubRepo> {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for tenant indexing.');
  }

  const token = await createInstallationAccessToken({ appId, privateKey }, installationId);
  const res = await fetch(`${GITHUB_API}/repos/${repoRef}`, {
    headers: githubApiHeaders(token),
  });
  if (res.status === 404 || res.status === 403) {
    throw new Error(
      `cannot access ${repoRef} via GitHub App installation ${installationId}`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} while checking ${repoRef}.`);
  }
  return (await res.json()) as GithubRepo;
}

async function fetchRepoWithPat(env: Env, repoRef: string): Promise<GithubRepo> {
  const res = await fetch(`${GITHUB_API}/repos/${repoRef}`, {
    headers: githubApiHeaders(env.GITHUB_PAT!),
  });
  if (res.status === 404 || res.status === 403) {
    throw new Error(`cannot access ${repoRef} with configured GITHUB_PAT`);
  }
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} while checking ${repoRef}.`);
  }
  return (await res.json()) as GithubRepo;
}

async function markStep(
  env: Env,
  tenantId: string,
  step: string,
  status: 'PENDING' | 'COMPLETE' | 'FAILED',
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_onboarding_steps (tenant_id, step, status, updated_at)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(tenant_id, step) DO UPDATE SET
       status = excluded.status,
       updated_at = datetime('now')`,
  )
    .bind(tenantId, step, status)
    .run();
}

function dispatchHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'scintel-slack-bot',
    'x-github-api-version': '2022-11-28',
  };
}

function githubApiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'scintel-slack-bot',
    'x-github-api-version': '2022-11-28',
  };
}
