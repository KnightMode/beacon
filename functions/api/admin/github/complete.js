import {
  clearGithubLinkCookie,
  handleError,
  HttpError,
  json,
  recordGithubInstallation,
  requireSession,
} from '../../../_lib/admin.js';

export async function onRequestPost(context) {
  try {
    const session = await requireSession(context);
    const body = await context.request.json().catch(() => ({}));
    const installationId = Number(body.installationId || body.installation_id || 0);
    if (!installationId) {
      throw new HttpError(400, 'Enter the installation ID from your GitHub install settings URL.');
    }

    const accountLogin = String(body.accountLogin || body.account_login || `installation-${installationId}`).trim();
    const result = await recordGithubInstallation(context.env, {
      tenantId: session.tenantId,
      installationId,
      accountLogin,
      userId: session.userId,
    });

    return json(
      { ok: true, linkedRepos: result.linkedRepos },
      200,
      { 'set-cookie': clearGithubLinkCookie(context.request) },
    );
  } catch (err) {
    return handleError(err);
  }
}
