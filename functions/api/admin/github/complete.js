import {
  clearGithubLinkCookie,
  handleError,
  HttpError,
  json,
  readGithubLinkTenant,
  recordGithubInstallation,
  requireSession,
} from '../../../_lib/admin.js';
import { listInstallationRepositories } from '../../../_lib/github.js';

export async function onRequestPost(context) {
  try {
    const session = await requireSession(context);
    const body = await context.request.json().catch(() => ({}));
    const installationId = Number(body.installationId || body.installation_id || 0);
    if (!installationId) {
      throw new HttpError(400, 'Enter the installation ID from your GitHub install settings URL.');
    }
    const linkedTenant = await readGithubLinkTenant(context);
    if (linkedTenant !== session.tenantId) {
      throw new HttpError(401, 'Start Connect GitHub from this browser before finishing setup.');
    }

    const repos = await listInstallationRepositories(context.env, installationId);
    if (!repos) {
      throw new HttpError(
        500,
        'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required to verify the GitHub installation.',
      );
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
