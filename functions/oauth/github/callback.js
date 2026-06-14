import { parseRepoRef } from '@scintel/shared';
import {
  clearGithubLinkCookie,
  clientErrorMessage,
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

    const session = await readSession(context);
    const accountLogin = url.searchParams.get('account_login')
      || url.searchParams.get('account')
      || `installation-${installationId}`;
    const accountType = url.searchParams.get('account_type') || 'Organization';
    const repos = url.searchParams.get('mock') === '1'
      ? await seedMockInstallationRepos(context.env, installationId)
      : [];

    await recordGithubInstallation(context.env, {
      tenantId,
      installationId,
      accountLogin,
      accountType,
      repos,
      userId: session?.userId,
    });

    return redirect('/admin/onboarding/?github=connected', {
      'set-cookie': clearGithubLinkCookie(context.request),
    });
  } catch (err) {
    console.error('GitHub OAuth callback failed', err);
    const message = clientErrorMessage(err, 'GitHub connection failed. Try again or contact support.');
    return redirect(`/admin/onboarding/?error=${encodeURIComponent(message)}`);
  }
}

async function seedMockInstallationRepos(env, installationId) {
  const samples = installationId === 67890
    ? ['acme-corp/api', 'acme-corp/web']
    : ['KnightMode/beacon', 'KnightMode/slack-code-intelligence'];
  const repos = [];
  for (const fullName of samples) {
    const repo = parseRepoRef(fullName);
    if (!repo) continue;
    repos.push({
      fullName: repo.fullName,
      githubId: installationId * 1000 + repos.length + 1,
      defaultBranch: 'main',
      private: true,
    });
  }
  return repos;
}
