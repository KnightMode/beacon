/**
 * Slack Web API helpers shared by history, reactions, and thread actions.
 */

import type { Env } from './env.js';
import { fetchThreadHistory, type Turn } from './history.js';

const SLACK_API = 'https://slack.com/api';

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  text?: string;
}

interface HistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
}

/** Fetch the text of a single message by ts. */
export async function fetchMessageText(
  env: Env,
  channel: string,
  messageTs: string,
): Promise<string> {
  try {
    const url =
      `${SLACK_API}/conversations.history` +
      `?channel=${encodeURIComponent(channel)}` +
      `&latest=${encodeURIComponent(messageTs)}` +
      `&inclusive=true&limit=1`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = (await res.json()) as HistoryResponse;
    return data.messages?.[0]?.text?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Resolve the thread root ts for any message (the message itself if top-level). */
export async function resolveThreadRoot(
  env: Env,
  channel: string,
  messageTs: string,
): Promise<string | null> {
  try {
    const url =
      `${SLACK_API}/conversations.history` +
      `?channel=${encodeURIComponent(channel)}` +
      `&latest=${encodeURIComponent(messageTs)}` +
      `&inclusive=true&limit=1`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = (await res.json()) as HistoryResponse;
    if (!data.ok || !data.messages?.[0]) {
      console.warn('conversations.history failed', { error: data.error });
      return null;
    }
    const msg = data.messages[0];
    return msg.thread_ts ?? msg.ts ?? messageTs;
  } catch (err) {
    console.warn('resolveThreadRoot error', { error: (err as Error).message });
    return null;
  }
}

/** Build a single issue description from all user turns in a thread. */
export async function buildIssueFromThread(
  env: Env,
  channel: string,
  threadTs: string,
): Promise<string> {
  const turns = await fetchThreadHistory(env, channel, threadTs);
  const userLines = turns.filter((t) => t.role === 'user').map((t) => t.text);
  if (userLines.length === 0) return '';
  return userLines.join('\n\n');
}

export function formatThreadForDisplay(turns: Turn[]): string {
  return turns.map((t) => `*${t.role}:* ${t.text}`).join('\n\n');
}
