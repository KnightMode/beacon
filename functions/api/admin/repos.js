import {
  createRepositoryDispatch,
  isValidRepoFullName,
  repoIdFor,
} from '@scintel/shared';
import {
  audit,
  handleError,
  HttpError,
  json,
  listTenantRepos,
  markStep,
  requireSession,
  upsertRepo,
} from '../../_lib/admin.js';
import { findInstallationRepository } from '../../_lib/github.js';

export async function onRequestGet(context) {
  try {
    const session = await requireSession(context);
    return json({ repos: await listTenantRepos(context.env, session.tenantId) });
  } catch (err) {
    return handleError(err);
  }
}

export async function onRequestPost(context) {
  try {
    const session = await requireSession(context);
    const body = await context.request.json();
    const repos = normalizeRepos(body.repos);
    if (repos.length === 0) throw new HttpError(400, 'Add at least one owner/repo.');

    const dispatchErrors = [];
    for (const repoInput of repos) {
      const repoGrant = await resolveTenantInstallationRepo(
        context.env,
        session.tenantId,
        repoInput.fullName,
        repoInput.installationId,
      );
      const repo = await upsertRepo(context.env, repoGrant);
      await context.env.DB.prepare(
        `INSERT INTO tenant_repos (tenant_id, repo_id, installation_id, full_name, enabled, selected_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, datetime('now'))
         ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
           enabled = 1,
           installation_id = excluded.installation_id,
           full_name = excluded.full_name,
           selected_by = COALESCE(excluded.selected_by, tenant_repos.selected_by),
           updated_at = datetime('now')`,
      )
        .bind(session.tenantId, repo.repoId, repoGrant.installationId, repo.fullName, session.userId || null)
        .run();

      await markRepoIndexRequested(context.env, repo.repoId);

      const dispatchError = await dispatchIndex(context, {
        tenantId: session.tenantId,
        repoId: repo.repoId,
        repoFullName: repo.fullName,
        installationId: repoGrant.installationId,
      });
      if (dispatchError) dispatchErrors.push({ repo: repo.fullName, error: dispatchError });
      await audit(context.env, session.tenantId, session.userId, 'repo.selected', 'repo', repo.repoId, repo);
    }

    await markStep(context.env, session.tenantId, 'repos', 'COMPLETE', { count: repos.length });
    await markStep(context.env, session.tenantId, 'indexing', 'PENDING');
    return json({
      ok: dispatchErrors.length === 0,
      repos: await listTenantRepos(context.env, session.tenantId),
      dispatchErrors,
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function markRepoIndexRequested(env, repoId) {
  await env.DB.prepare(
    `INSERT INTO repo_index_status (repo_id, status, job_type, updated_at)
     VALUES (
       ?1,
       CASE
         WHEN (SELECT indexing_status FROM repos WHERE id = ?1) = 'READY' THEN 'READY'
         ELSE 'PENDING'
       END,
       'FULL_INDEX',
       datetime('now')
     )
     ON CONFLICT(repo_id) DO UPDATE SET
       status = CASE
         WHEN repo_index_status.status = 'READY' THEN 'READY'
         WHEN (SELECT indexing_status FROM repos WHERE id = ?1) = 'READY' THEN 'READY'
         ELSE 'PENDING'
       END,
       job_type = 'FULL_INDEX',
       error = CASE
         WHEN repo_index_status.status = 'READY' THEN repo_index_status.error
         ELSE NULL
       END,
       updated_at = datetime('now')`,
  )
    .bind(repoId)
    .run();
}

function normalizeRepos(input) {
  const values = Array.isArray(input) ? input : [];
  return values.map((value) => {
    if (typeof value === 'string') return { fullName: value };
    return {
      fullName: value.fullName || value.full_name || '',
      installationId: Number(value.installationId || value.installation_id || 0) || undefined,
      githubId: value.githubId || value.github_id,
      defaultBranch: value.defaultBranch || value.default_branch,
      private: value.private,
    };
  }).filter((repo) => isValidRepoFullName(repo.fullName));
}

export async function resolveTenantInstallationRepo(env, tenantId, fullName, installationId) {
  const { results: installations } = await env.DB.prepare(
    `SELECT installation_id
     FROM tenant_github_installations
     WHERE tenant_id = ?1
       AND (?2 IS NULL OR installation_id = ?2)
     ORDER BY account_login, installation_id`,
  )
    .bind(tenantId, installationId || null)
    .all();
  if (installations.length === 0) {
    throw new HttpError(400, 'Connect GitHub before choosing repos.');
  }

  const repoId = repoIdFor(fullName);
  for (const installation of installations) {
    const localGrant = await env.DB.prepare(
      `SELECT gir.full_name, gir.github_id, gir.default_branch, gir.private, gir.installation_id
       FROM github_installation_repos gir
       WHERE gir.installation_id = ?1 AND gir.repo_id = ?2
       UNION ALL
       SELECT p.full_name, r.github_id, r.default_branch, r.private, p.installation_id
       FROM pending_installation_repos p
       LEFT JOIN repos r ON r.id = p.repo_id
       WHERE p.installation_id = ?1 AND p.repo_id = ?2
       UNION ALL
       SELECT tr.full_name, r.github_id, r.default_branch, r.private, tr.installation_id
       FROM tenant_repos tr
       LEFT JOIN repos r ON r.id = tr.repo_id
       WHERE tr.tenant_id = ?3 AND tr.repo_id = ?2 AND tr.enabled = 1
       LIMIT 1`,
    )
      .bind(installation.installation_id, repoId, tenantId)
      .first();
    if (localGrant?.full_name) return repoFromGrant(localGrant, installation.installation_id);

    const githubRepo = await findInstallationRepository(env, installation.installation_id, fullName);
    if (githubRepo) return { ...githubRepo, installationId: installation.installation_id };
  }

  throw new HttpError(
    403,
    `${fullName} is not available on this tenant's GitHub App installation.`,
  );
}

function repoFromGrant(row, fallbackInstallationId) {
  return {
    fullName: row.full_name,
    installationId: row.installation_id || fallbackInstallationId,
    githubId: row.github_id,
    defaultBranch: row.default_branch || 'main',
    private: row.private === 0 ? false : true,
  };
}

async function dispatchIndex(context, job) {
  const { env, request } = context;
  if (env.BEACON_LOCAL_E2E === '1' && isLocalRequest(request)) {
    await markLocalIndexReady(env, job.repoId);
    return null;
  }
  if (env.PIPELINE_DISPATCH_REPO && env.PIPELINE_DISPATCH_TOKEN) {
    const res = await createRepositoryDispatch({
      repository: env.PIPELINE_DISPATCH_REPO,
      token: env.PIPELINE_DISPATCH_TOKEN,
      eventType: env.PIPELINE_DISPATCH_EVENT || 'index-repo',
      clientPayload: {
        repo: job.repoFullName,
        repoId: job.repoId,
        tenantId: job.tenantId,
        installationId: job.installationId,
        jobType: 'FULL_INDEX',
      },
      userAgent: 'beacon-admin-portal',
    });
    if (!res.ok) {
      console.error('GitHub Actions index dispatch failed', {
        repo: job.repoFullName,
        status: res.status,
        body: res.body.slice(0, 200),
      });
      return 'Could not start indexing for this repository. Try again or contact support.';
    }
    return null;
  }

  if (env.INDEXER_URL && env.INDEXER_SHARED_SECRET) {
    const res = await fetch(`${env.INDEXER_URL.replace(/\/$/, '')}/index`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.INDEXER_SHARED_SECRET}`,
      },
      body: JSON.stringify({
        jobType: 'FULL_INDEX',
        tenantId: job.tenantId,
        installationId: job.installationId,
        repoId: job.repoId,
        repoFullName: job.repoFullName,
        enqueuedAt: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Hosted indexer dispatch failed', {
        repo: job.repoFullName,
        status: res.status,
        body: text.slice(0, 200),
      });
      return 'Could not start indexing for this repository. Try again or contact support.';
    }
    return null;
  }

  console.error('Index dispatch is not configured.');
  return 'Indexing is not configured. Contact an administrator.';
}

async function markLocalIndexReady(env, repoId) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE repos
       SET indexing_status = 'READY',
           last_indexed_sha = COALESCE(last_indexed_sha, 'local-e2e'),
           last_indexed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?1`,
    ).bind(repoId),
    env.DB.prepare(
      `INSERT INTO repo_index_status
         (repo_id, status, job_type, total_files, indexed_files, total_chunks, commit_sha, started_at, finished_at, updated_at)
       VALUES (?1, 'READY', 'FULL_INDEX', 2, 2, 4, 'local-e2e', datetime('now'), datetime('now'), datetime('now'))
       ON CONFLICT(repo_id) DO UPDATE SET
         status = 'READY',
         job_type = 'FULL_INDEX',
         total_files = 2,
         indexed_files = 2,
         total_chunks = 4,
         commit_sha = 'local-e2e',
         error = NULL,
         finished_at = datetime('now'),
         updated_at = datetime('now')`,
    ).bind(repoId),
  ]);
}

function isLocalRequest(request) {
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
