import { HttpError } from './admin.js';

const SLACK_API = 'https://slack.com/api';

export async function slackPostForm(method, params, options = {}) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });

  const body = await res.json().catch(() => null);
  const label = options.label || method;
  if (!res.ok) {
    throw new HttpError(400, `Slack ${label} failed: HTTP ${res.status}`);
  }
  if (!body?.ok) {
    throw new HttpError(400, `Slack ${label} failed: ${body?.error || 'unknown'}`);
  }
  return body;
}
