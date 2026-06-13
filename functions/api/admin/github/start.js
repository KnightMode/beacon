import { githubLinkCookie, redirect, requireSession } from '../../../_lib/admin.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  if (url.searchParams.get('mock') === '1') {
    return redirect('/oauth/github/callback?mock=1&installation_id=12345');
  }

  const session = await requireSession(context);
  const githubApp = context.env.GITHUB_APP_SLUG?.trim() || context.env.GITHUB_APP_NAME?.trim() || '';
  if (!githubApp) {
    return redirect(
      '/admin/onboarding/?error=GitHub%20App%20is%20not%20configured.%20Contact%20an%20administrator.',
    );
  }
  const state = encodeURIComponent(session.tenantId);
  const installUrl = `https://github.com/apps/${githubApp}/installations/new?state=${state}`;
  return redirect(installUrl, {
    'set-cookie': await githubLinkCookie(context, session.tenantId),
  });
}
