import type { Env } from './env.js';
import { getSlackBotToken } from './tenant.js';

const SLACK_API = 'https://slack.com/api';

export interface SlackWebResponse {
  ok: boolean;
  error?: string;
}

type SlackParamValue = string | number | boolean | null | undefined;
type SlackParams = Record<string, SlackParamValue>;

export async function slackGet<T extends SlackWebResponse>(
  env: Env,
  method: string,
  params: SlackParams,
  teamId?: string,
): Promise<T> {
  const url = new URL(`${SLACK_API}/${method}`);
  appendParams(url.searchParams, params);

  const res = await fetch(url.toString(), {
    headers: await slackAuthHeaders(env, teamId),
  });
  return parseSlackResponse<T>(res);
}

export async function slackPostJson<T extends SlackWebResponse>(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  teamId?: string,
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      ...(await slackAuthHeaders(env, teamId)),
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  return parseSlackResponse<T>(res);
}

async function slackAuthHeaders(env: Env, teamId?: string): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await getSlackBotToken(env, teamId)}`,
  };
}

function appendParams(searchParams: URLSearchParams, params: SlackParams): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    searchParams.set(key, String(value));
  }
}

async function parseSlackResponse<T extends SlackWebResponse>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `http_${res.status}:${text.slice(0, 200)}`,
    } as T;
  }
  return (await res.json()) as T;
}
