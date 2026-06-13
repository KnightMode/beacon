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
      '/admin/onboarding/?error=GITHUB_APP_SLUG%20is%20not%20configured.%20Create%20a%20GitHub%20App%20and%20set%20its%20slug%20in%20.dev.vars.',
    );
  }
  const state = encodeURIComponent(session.tenantId);
  const installUrl = `https://github.com/apps/${githubApp}/installations/new?state=${state}`;
  return redirect(installUrl, {
    'set-cookie': await githubLinkCookie(context, session.tenantId),
  });
}
