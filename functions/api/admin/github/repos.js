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

    const requestedInstallationId = Number(url.searchParams.get('installationId') || 0);
    const { results: installations } = await context.env.DB.prepare(
      `SELECT installation_id, account_login, account_type
       FROM tenant_github_installations
       WHERE tenant_id = ?1
       ORDER BY account_login, installation_id`,
    )
      .bind(session.tenantId)
      .all();
    const scopedInstallations = requestedInstallationId
      ? installations.filter((row) => Number(row.installation_id) === requestedInstallationId)
      : installations;
    if (installations.length === 0) {
      throw new HttpError(400, 'Connect GitHub before choosing repos.');
    }
    if (requestedInstallationId && scopedInstallations.length === 0) {
      throw new HttpError(404, 'That GitHub installation is not connected to this workspace.');
    }

    const selectedRepos = await listTenantRepos(context.env, session.tenantId);
    const selected = new Map(selectedRepos.map((repo) => [repo.fullName, repo]));

    let repos = [];
    let source = 'empty';
    let message = null;
    let hasMore = false;
    let totalScanned = 0;

    for (const installation of scopedInstallations) {
      try {
        const githubResult = await queryInstallationRepositories(
          context.env,
          installation.installation_id,
          { q, page, limit },
        );
        if (githubResult) {
          repos.push(...githubResult.repos.map((repo) => ({
            ...repo,
            installationId: installation.installation_id,
            accountLogin: installation.account_login,
          })));
          hasMore = hasMore || githubResult.hasMore;
          totalScanned += githubResult.totalScanned;
          source = 'github-api';
          continue;
        }
      } catch (err) {
        console.error('GitHub repo list failed', err);
        message = 'Could not load repositories from GitHub. Try again or contact support.';
      }

      const fallback = await listReposFromDatabase(context.env, installation.installation_id, q);
      if (fallback.length > 0) {
        repos.push(...fallback.slice(0, limit).map((repo) => ({
          ...repo,
          installationId: installation.installation_id,
          accountLogin: installation.account_login,
        })));
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
      installations: installations.map((installation) => ({
        id: installation.installation_id,
        accountLogin: installation.account_login,
        accountType: installation.account_type,
      })),
      installation: scopedInstallations.length === 1 ? {
        id: scopedInstallations[0].installation_id,
        accountLogin: scopedInstallations[0].account_login,
      } : null,
      repos: repos.map((repo) => ({
        ...repo,
        selected: selected.has(repo.fullName),
        selectedInstallationId: selected.get(repo.fullName)?.installationId || null,
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

async function listReposFromDatabase(env, installationId, q = '') {
  const needle = String(q || '').trim().toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT gir.full_name, gir.github_id, gir.default_branch, gir.private
     FROM github_installation_repos gir
     WHERE installation_id = ?1
     ORDER BY full_name`,
  )
    .bind(installationId)
    .all();

  return results.filter((row) => {
    if (!needle) return true;
    return String(row.full_name || '').toLowerCase().includes(needle);
  }).map((row) => ({
    fullName: row.full_name,
    githubId: row.github_id,
    defaultBranch: row.default_branch || 'main',
    private: row.private === 0 ? false : true,
  }));
}

function missingGitHubAppConfigMessage(request) {
  const host = new URL(request.url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'Repo list is not configured locally. Contact an administrator.';
  }
  return 'Repo list is not configured. Contact an administrator.';
}
