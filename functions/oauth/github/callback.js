import {
  clearGithubLinkCookie,
  HttpError,
  readSession,
  recordGithubInstallation,
  redirect,
  resolveGithubTenantId,
} from '../../_lib/admin.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const setupAction = url.searchParams.get('setup_action');
    if (setupAction === 'request') {
      return redirect(
        '/admin/onboarding/?error=GitHub%20install%20is%20pending%20org%20admin%20approval.%20Return%20here%20after%20approval%20and%20use%20Finish%20setup%20below.',
      );
    }

    const tenantId = await resolveGithubTenantId(context, url.searchParams.get('state'));
    if (!tenantId) {
      throw new HttpError(
        401,
        'Connect Slack before GitHub, then start Connect GitHub again from this browser.',
      );
    }

    const installationId = Number(url.searchParams.get('installation_id') || 0);
    if (!installationId) {
      throw new HttpError(
        400,
        'Missing GitHub installation_id. Set the GitHub App Setup URL to this callback, or use Finish setup below.',
      );
    }

    if (url.searchParams.get('mock') === '1') {
      await seedMockInstallationRepos(context.env, installationId);
    }

    const session = await readSession(context);
    const accountLogin = url.searchParams.get('account_login')
      || url.searchParams.get('account')
      || `installation-${installationId}`;

    await recordGithubInstallation(context.env, {
      tenantId,
      installationId,
      accountLogin,
      userId: session?.userId,
    });

    return redirect('/admin/onboarding/?github=connected', {
      'set-cookie': clearGithubLinkCookie(context.request),
    });
  } catch (err) {
    const message = err instanceof HttpError ? err.message : 'GitHub connection failed.';
    return redirect(`/admin/onboarding/?error=${encodeURIComponent(message)}`);
  }
}

async function seedMockInstallationRepos(env, installationId) {
  const samples = ['KnightMode/beacon', 'acme-corp/api'];
  for (const fullName of samples) {
    const [owner, name] = fullName.split('/');
    const repoId = fullName.toLowerCase();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO repos (id, full_name, owner, name, default_branch, private, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'main', 1, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           full_name = excluded.full_name,
           updated_at = datetime('now')`,
      ).bind(repoId, fullName, owner, name),
      env.DB.prepare(
        `INSERT INTO pending_installation_repos (installation_id, repo_id, full_name)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(installation_id, repo_id) DO UPDATE SET full_name = excluded.full_name`,
      ).bind(installationId, repoId, fullName),
    ]);
  }
}
