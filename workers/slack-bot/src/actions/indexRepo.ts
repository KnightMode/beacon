/**
 * Self-serve repo indexing from Slack. Tenant workspaces validate the repo
 * against their GitHub App installation grants and enqueue an index job with
 * tenant + installation context. The github-webhook consumer dispatches that
 * job to the GitHub Actions indexer runner.
 */

import type { Env } from '../env.js';
import {
  createRepositoryDispatch,
  githubJsonHeaders,
  JOB_TYPES,
  parseRepoRef,
  type FullIndexJob,
} from '@scintel/shared';
import {
  getTenantRepoGrant,
  getTenantIdForSlackTeam,
} from '../tenant.js';
import { GitHubClient } from '../github.js';

const GITHUB_API = 'https://api.github.com';
const DISPATCH_EVENT = 'index-repo';
const USER_AGENT = 'scintel-slack-bot';
const ONBOARDING_REQUIRED =
  ':information_source: This workspace is not onboarded yet. Open the admin portal, ' +
  'connect Slack, then add repos there before indexing from chat.';

interface GithubRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}

/** Validates repo access, records the selection, and kicks off indexing. */
export async function indexRepoAction(
  env: Env,
  repoRef: string,
  teamId?: string,
): Promise<string> {
  const requestedRepo = parseRepoRef(repoRef);
  if (!requestedRepo) {
    return ':warning: Use `index owner/repo` with a valid GitHub repository name.';
  }

  const tenantId = await getTenantIdForSlackTeam(env, teamId);
  if (teamId && !tenantId) {
    return ONBOARDING_REQUIRED;
  }

  let repo: GithubRepo;
  let installationId: number | undefined;

  if (tenantId) {
    const grant = await getTenantRepoGrant(env, tenantId, requestedRepo.id);
    if (!grant) {
      return (
        `:no_entry: \`${repoRef}\` is not available on this workspace's ` +
        'GitHub App installation. Add it in the admin portal first, then try indexing again.'
      );
    }
    installationId = grant.installationId;
    const grantRepo = parseRepoRef(grant.fullName);
    if (!grantRepo) return `:warning: Invalid repository: \`${grant.fullName}\`.`;
    const gh = await GitHubClient.forTenantRepo(env, teamId, grantRepo.fullName);
    if (!gh) {
      return ':warning: GitHub App access is not configured for this workspace.';
    }
    const info = await gh.getRepo(grantRepo.owner, grantRepo.name);
    repo = {
      id: info.id,
      full_name: info.fullName,
      default_branch: info.defaultBranch,
      private: info.private,
    };
  } else {
    if (!env.GITHUB_PAT) {
      return ':warning: `GITHUB_PAT` is not configured on the bot, so I cannot index repos.';
    }
    const dispatchRepo = env.INDEX_DISPATCH_REPO || env.DEFAULT_PR_REPO;
    if (!dispatchRepo) {
      return ':warning: `INDEX_DISPATCH_REPO` is not configured, so I cannot trigger the indexing pipeline.';
    }

    const res = await fetch(
      `${GITHUB_API}/repos/${encodeURIComponent(requestedRepo.owner)}/${encodeURIComponent(requestedRepo.name)}`,
      {
        headers: githubJsonHeaders(env.GITHUB_PAT, USER_AGENT),
      },
    );
    if (res.status === 404 || res.status === 403) {
      return (
        `:no_entry: I can't access \`${repoRef}\` on GitHub. Either it doesn't ` +
        'exist, or my legacy GitHub token has not been granted access to it.'
      );
    }
    if (!res.ok) {
      return `:warning: GitHub returned ${res.status} while checking \`${repoRef}\`.`;
    }
    repo = (await res.json()) as GithubRepo;
  }

  const canonicalRepo = parseRepoRef(repo.full_name);
  if (!canonicalRepo) {
    return `:warning: GitHub returned an invalid repository name for \`${repoRef}\`.`;
  }
  const repoId = canonicalRepo.id;

  // 2. Upsert the repo row and mark indexing PENDING.
  await env.DB.prepare(
    `INSERT INTO repos (id, github_id, full_name, owner, name, default_branch, private, indexing_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PENDING', datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_id = excluded.github_id,
       default_branch = excluded.default_branch,
       private = excluded.private,
       updated_at = datetime('now')`,
  )
    .bind(
      repoId,
      repo.id,
      canonicalRepo.fullName,
      canonicalRepo.owner,
      canonicalRepo.name,
      repo.default_branch,
      repo.private ? 1 : 0,
    )
    .run();

  if (tenantId) {
    await env.DB.prepare(
      `INSERT INTO tenant_repos (tenant_id, repo_id, installation_id, full_name, enabled, selected_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, 'slack-index-intent', datetime('now'))
       ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
         enabled = 1,
         installation_id = excluded.installation_id,
         full_name = excluded.full_name,
         updated_at = datetime('now')`,
    )
      .bind(tenantId, repoId, installationId, canonicalRepo.fullName)
      .run();

    await markStep(env, tenantId, 'repos', 'COMPLETE');
    await markStep(env, tenantId, 'indexing', 'PENDING');
  } else {
    await env.DB.prepare(
      `INSERT INTO prototype_repo_allowlist (repo_id, full_name, enabled, added_by)
       VALUES (?1, ?2, 1, 'slack-index-intent')
       ON CONFLICT(repo_id) DO UPDATE SET enabled = 1, full_name = excluded.full_name`,
    )
      .bind(repoId, canonicalRepo.fullName)
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

  if (tenantId) {
    if (!env.INDEX_QUEUE) {
      return ':warning: Indexing is not configured on the bot worker. Contact an administrator.';
    }
    const job: FullIndexJob = {
      jobType: JOB_TYPES.FULL_INDEX,
      tenantId,
      installationId,
      repoId,
      repoFullName: canonicalRepo.fullName,
      enqueuedAt: new Date().toISOString(),
    };
    await env.INDEX_QUEUE.send(job);
    return (
      `:hammer_and_wrench: Indexing *${canonicalRepo.fullName}* (default branch ` +
      `\`${repo.default_branch}\`) — a full index is running. Say ` +
      '`index status` to check progress; once it shows READY you can ask questions about the repo.'
    );
  }

  // 3. Fire the GitHub Actions indexing pipeline directly for non-tenant/dev usage.
  const dispatchRepo = env.INDEX_DISPATCH_REPO || env.DEFAULT_PR_REPO;
  const dispatchToken = env.GITHUB_PAT;
  if (!dispatchRepo || !dispatchToken) {
    return ':warning: Indexing is not configured on the bot worker. Contact an administrator.';
  }
  const dispatch = await createRepositoryDispatch({
    repository: dispatchRepo,
    token: dispatchToken,
    eventType: DISPATCH_EVENT,
    clientPayload: { repo: canonicalRepo.fullName, jobType: 'FULL_INDEX' },
    userAgent: USER_AGENT,
  });
  if (!dispatch.ok) {
    return (
      `:warning: \`${canonicalRepo.fullName}\` is allowlisted, but triggering the ` +
      `indexing pipeline failed (${dispatch.status}): ${dispatch.body.slice(0, 200)}`
    );
  }

  return (
    `:hammer_and_wrench: Indexing *${canonicalRepo.fullName}* (default branch ` +
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
