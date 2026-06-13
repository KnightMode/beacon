import { oauthStateCookie, redirect } from '../../../_lib/admin.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  if (url.searchParams.get('mock') === '1') {
    return redirect('/oauth/slack/callback?mock=1');
  }
  if (!context.env.SLACK_CLIENT_ID?.trim()) {
    return redirect('/admin/onboarding/?error=SLACK_CLIENT_ID%20is%20not%20configured.');
  }
  if (!context.env.ADMIN_SESSION_SECRET?.trim()) {
    return redirect('/admin/onboarding/?error=ADMIN_SESSION_SECRET%20is%20not%20configured.');
  }
  if (!context.env.SLACK_TOKEN_ENCRYPTION_SECRET?.trim()) {
    return redirect('/admin/onboarding/?error=SLACK_TOKEN_ENCRYPTION_SECRET%20is%20not%20configured.');
  }

  const redirectUri = `${url.origin}/oauth/slack/callback`;
  const state = crypto.randomUUID();
  const scopes = [
    'commands',
    'app_mentions:read',
    'chat:write',
    'reactions:read',
    'channels:history',
    'channels:read',
    'groups:read',
    'im:history',
  ].join(',');
  const slack = new URL('https://slack.com/oauth/v2/authorize');
  slack.searchParams.set('client_id', context.env.SLACK_CLIENT_ID || '');
  slack.searchParams.set('scope', scopes);
  slack.searchParams.set('redirect_uri', redirectUri);
  slack.searchParams.set('state', state);
  return redirect(slack.toString(), {
    'set-cookie': oauthStateCookie(context.request, state),
  });
}
