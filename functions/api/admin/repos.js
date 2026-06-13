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
      );
      const repo = await upsertRepo(context.env, repoGrant);
      await context.env.DB.prepare(
        `INSERT INTO tenant_repos (tenant_id, repo_id, full_name, enabled, selected_by, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, datetime('now'))
         ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
           enabled = 1,
           full_name = excluded.full_name,
           selected_by = COALESCE(excluded.selected_by, tenant_repos.selected_by),
           updated_at = datetime('now')`,
      )
        .bind(session.tenantId, repo.repoId, repo.fullName, session.userId || null)
        .run();

      await context.env.DB.prepare(
        `INSERT INTO repo_index_status (repo_id, status, job_type, updated_at)
         VALUES (?1, 'PENDING', 'FULL_INDEX', datetime('now'))
         ON CONFLICT(repo_id) DO UPDATE SET
           status = 'PENDING',
           job_type = 'FULL_INDEX',
           error = NULL,
           updated_at = datetime('now')`,
      )
        .bind(repo.repoId)
        .run();

      const dispatchError = await dispatchIndex(context.env, repo.fullName);
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

function normalizeRepos(input) {
  const values = Array.isArray(input) ? input : [];
  return values.map((value) => {
    if (typeof value === 'string') return { fullName: value };
    return {
      fullName: value.fullName || value.full_name || '',
      githubId: value.githubId || value.github_id,
      defaultBranch: value.defaultBranch || value.default_branch,
      private: value.private,
    };
  }).filter((repo) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.fullName));
}

export async function resolveTenantInstallationRepo(env, tenantId, fullName) {
  const installation = await env.DB.prepare(
    `SELECT installation_id
     FROM tenant_github_installations
     WHERE tenant_id = ?1
     ORDER BY updated_at DESC
     LIMIT 1`,
  )
    .bind(tenantId)
    .first();
  if (!installation?.installation_id) {
    throw new HttpError(400, 'Connect GitHub before choosing repos.');
  }

  const repoId = fullName.toLowerCase();
  const localGrant = await env.DB.prepare(
    `SELECT p.full_name, r.github_id, r.default_branch, r.private
     FROM pending_installation_repos p
     LEFT JOIN repos r ON r.id = p.repo_id
     WHERE p.installation_id = ?1 AND p.repo_id = ?2
     UNION ALL
     SELECT tr.full_name, r.github_id, r.default_branch, r.private
     FROM tenant_repos tr
     LEFT JOIN repos r ON r.id = tr.repo_id
     WHERE tr.tenant_id = ?3 AND tr.repo_id = ?2 AND tr.enabled = 1
     LIMIT 1`,
  )
    .bind(installation.installation_id, repoId, tenantId)
    .first();
  if (localGrant?.full_name) return repoFromGrant(localGrant);

  const githubRepo = await findInstallationRepository(env, installation.installation_id, fullName);
  if (githubRepo) return githubRepo;

  throw new HttpError(
    403,
    `${fullName} is not available on this tenant's GitHub App installation.`,
  );
}

function repoFromGrant(row) {
  return {
    fullName: row.full_name,
    githubId: row.github_id,
    defaultBranch: row.default_branch || 'main',
    private: row.private === 0 ? false : true,
  };
}

async function dispatchIndex(env, repoFullName) {
  if (!env.PIPELINE_DISPATCH_REPO || !env.PIPELINE_DISPATCH_TOKEN) {
    return 'PIPELINE_DISPATCH_REPO or PIPELINE_DISPATCH_TOKEN is not configured.';
  }
  const res = await fetch(`https://api.github.com/repos/${env.PIPELINE_DISPATCH_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.PIPELINE_DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'beacon-admin-portal',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      event_type: env.PIPELINE_DISPATCH_EVENT || 'index-repo',
      client_payload: { repo: repoFullName, jobType: 'FULL_INDEX' },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return `GitHub dispatch failed (${res.status}): ${text.slice(0, 200)}`;
  }
  return null;
}
