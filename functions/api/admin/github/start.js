import {
  githubLinkCookie,
  HttpError,
  logInternalError,
  redirect,
  requireSession,
} from '../../../_lib/admin.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  if (url.searchParams.get('mock') === '1') {
    const installationId = url.searchParams.get('installation_id') || '12345';
    const accountLogin = url.searchParams.get('account_login') || (
      installationId === '67890' ? 'acme-corp' : 'KnightMode'
    );
    return redirect(
      `/oauth/github/callback?mock=1&installation_id=${encodeURIComponent(installationId)}` +
        `&account_login=${encodeURIComponent(accountLogin)}`,
    );
  }

  if (!context.env.ADMIN_SESSION_SECRET?.trim()) {
    return redirect(
      '/admin/onboarding/?error=GitHub%20connection%20is%20not%20configured.%20Contact%20an%20administrator.',
    );
  }

  const githubApp = context.env.GITHUB_APP_SLUG?.trim() || context.env.GITHUB_APP_NAME?.trim() || '';
  if (!githubApp) {
    return redirect(
      '/admin/onboarding/?error=GitHub%20App%20is%20not%20configured.%20Contact%20an%20administrator.',
    );
  }

  try {
    const session = await requireSession(context);
    const state = encodeURIComponent(session.tenantId);
    const installUrl = `https://github.com/apps/${githubApp}/installations/new?state=${state}`;
    return redirect(installUrl, {
      'set-cookie': await githubLinkCookie(context, session.tenantId),
    });
  } catch (err) {
    logInternalError('GitHub connect start failed', err);
    const message =
      err instanceof HttpError && err.status < 500
        ? err.message
        : 'GitHub connection failed. Try again or contact support.';
    return redirect(`/admin/onboarding/?error=${encodeURIComponent(message)}`);
  }
}
