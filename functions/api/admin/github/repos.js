import {
  handleError,
  HttpError,
  json,
  listTenantRepos,
  requireSession,
} from '../../../_lib/admin.js';
import { queryInstallationRepositories } from '../../../_lib/github.js';

export async function onRequestGet(context) {
  try {
    const session = await requireSession(context);
    const url = new URL(context.request.url);
    const q = url.searchParams.get('q') || '';
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || 50);

    const installation = await context.env.DB.prepare(
      `SELECT installation_id, account_login
       FROM tenant_github_installations
       WHERE tenant_id = ?1
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
      .bind(session.tenantId)
      .first();
    if (!installation?.installation_id) {
      throw new HttpError(400, 'Connect GitHub before choosing repos.');
    }

    const selectedRepos = await listTenantRepos(context.env, session.tenantId);
    const selected = new Set(selectedRepos.map((repo) => repo.fullName));

    let repos = [];
    let source = 'empty';
    let message = null;
    let hasMore = false;
    let totalScanned = 0;

    try {
      const githubResult = await queryInstallationRepositories(
        context.env,
        installation.installation_id,
        { q, page, limit },
      );
      if (githubResult) {
        repos = githubResult.repos;
        hasMore = githubResult.hasMore;
        totalScanned = githubResult.totalScanned;
        source = 'github-api';
      }
    } catch (err) {
      console.error('GitHub repo list failed', err);
      message = 'Could not load repositories from GitHub. Try again or contact support.';
    }

    if (repos.length === 0 && !q) {
      const fallback = await listReposFromDatabase(context.env, installation.installation_id);
      if (fallback.length > 0) {
        repos = fallback.slice(0, limit);
        source = 'database';
        hasMore = fallback.length > limit;
      }
    }

    if (repos.length === 0 && !message) {
      message = q
        ? `No repositories match "${q}". Try a different owner or repo name.`
        : context.env.GITHUB_APP_ID?.trim() && context.env.GITHUB_APP_PRIVATE_KEY?.trim()
          ? 'No repositories are available on this GitHub installation yet.'
          : missingGitHubAppConfigMessage(context.request);
    }

    return json({
      installation: {
        id: installation.installation_id,
        accountLogin: installation.account_login,
      },
      repos: repos.map((repo) => ({
        ...repo,
        selected: selected.has(repo.fullName),
      })),
      selectedRepos: selectedRepos.map((repo) => ({
        fullName: repo.fullName,
        status: repo.status,
      })),
      page,
      hasMore,
      totalScanned,
      source,
      message,
    });
  } catch (err) {
    return handleError(err);
  }
}

async function listReposFromDatabase(env, installationId) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT full_name
     FROM pending_installation_repos
     WHERE installation_id = ?1
     ORDER BY full_name`,
  )
    .bind(installationId)
    .all();

  return results.map((row) => ({
    fullName: row.full_name,
    githubId: null,
    defaultBranch: 'main',
    private: true,
  }));
}

function missingGitHubAppConfigMessage(request) {
  const host = new URL(request.url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'Repo list is not configured locally. Contact an administrator.';
  }
  return 'Repo list is not configured. Contact an administrator.';
}
