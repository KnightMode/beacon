import {
  audit,
  clientErrorMessage,
  encryptSecret,
  handleError,
  HttpError,
  markStep,
  redirect,
  rememberAdminEmail,
  sessionCookie,
  validateOAuthState,
} from '../../_lib/admin.js';
import { slackPostForm } from '../../_lib/slackClient.js';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    if (url.searchParams.get('mock') !== '1') {
      validateOAuthState(context.request, url.searchParams.get('state'));
    }
    const install = url.searchParams.get('mock') === '1'
      ? mockInstall()
      : await exchangeSlackCode(context, url);

    const tenantId = install.team.id;
    const tokenEnc = install.access_token ? await encryptSecret(context.env, install.access_token) : null;

    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO tenants (id, name, slack_team_id, updated_at)
         VALUES (?1, ?2, ?1, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           updated_at = datetime('now')`,
      ).bind(tenantId, install.team.name || tenantId),
      context.env.DB.prepare(
        `INSERT INTO tenant_members (tenant_id, slack_user_id, role)
         VALUES (?1, ?2, 'ADMIN')
         ON CONFLICT(tenant_id, slack_user_id) DO UPDATE SET role = 'ADMIN'`,
      ).bind(tenantId, install.authed_user?.id || 'unknown'),
      context.env.DB.prepare(
        `INSERT INTO tenant_slack_installs
           (tenant_id, slack_team_id, team_name, bot_token_enc, bot_user_id, installer_user_id, updated_at)
         VALUES (?1, ?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(tenant_id) DO UPDATE SET
           team_name = excluded.team_name,
           bot_token_enc = COALESCE(excluded.bot_token_enc, tenant_slack_installs.bot_token_enc),
           bot_user_id = excluded.bot_user_id,
           installer_user_id = excluded.installer_user_id,
           updated_at = datetime('now')`,
      ).bind(
        tenantId,
        install.team.name || tenantId,
        tokenEnc,
        install.bot_user_id || null,
        install.authed_user?.id || null,
      ),
    ]);
    await markStep(context.env, tenantId, 'slack', 'COMPLETE');
    await rememberAdminEmail(context, tenantId);
    await audit(context.env, tenantId, install.authed_user?.id, 'slack.connected', 'tenant', tenantId, {
      team: install.team,
      botUserId: install.bot_user_id,
    });

    const cookie = await sessionCookie(context, {
      tenantId,
      userId: install.authed_user?.id || null,
    });
    // Returning workspaces that already finished onboarding land on the status
    // dashboard instead of replaying the onboarding journey.
    const tenant = await context.env.DB.prepare(
      `SELECT onboarding_completed_at FROM tenants WHERE id = ?1`,
    )
      .bind(tenantId)
      .first();
    const destination = tenant?.onboarding_completed_at ? '/admin/' : '/admin/onboarding/';
    return redirect(destination, { 'set-cookie': cookie });
  } catch (err) {
    console.error('Slack OAuth callback failed', err);
    if (new URL(context.request.url).pathname.endsWith('/callback.json')) {
      return handleError(err);
    }
    const message = clientErrorMessage(err, 'Slack sign-in failed. Try again or contact support.');
    return redirect(`/admin/onboarding/?error=${encodeURIComponent(message)}`);
  }
}

async function exchangeSlackCode(context, url) {
  const code = url.searchParams.get('code');
  if (!code) throw new HttpError(400, 'Missing Slack OAuth code.');
  const redirectUri = `${url.origin}/oauth/slack/callback`;
  return slackPostForm(
    'oauth.v2.access',
    {
      code,
      client_id: context.env.SLACK_CLIENT_ID || '',
      client_secret: context.env.SLACK_CLIENT_SECRET || '',
      redirect_uri: redirectUri,
    },
    { label: 'OAuth' },
  );
}

function mockInstall() {
  return {
    ok: true,
    access_token: 'xoxb-mock-token',
    bot_user_id: 'U_BEACON',
    team: { id: 'T_BEACON_DEMO', name: 'Beacon Demo' },
    authed_user: { id: 'U_ADMIN' },
  };
}
