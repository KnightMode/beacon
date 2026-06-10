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

interface RepliesResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
}

/** Fetch the text of a single message by ts (works for thread replies). */
export async function fetchMessageText(
  env: Env,
  channel: string,
  messageTs: string,
): Promise<string> {
  try {
    const repliesUrl =
      `${SLACK_API}/conversations.replies` +
      `?channel=${encodeURIComponent(channel)}` +
      `&ts=${encodeURIComponent(messageTs)}` +
      `&inclusive=true&limit=1`;
    const repliesRes = await fetch(repliesUrl, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const replies = (await repliesRes.json()) as RepliesResponse;
    if (replies.ok && replies.messages?.[0]?.text) {
      return replies.messages[0].text.trim();
    }

    const historyUrl =
      `${SLACK_API}/conversations.history` +
      `?channel=${encodeURIComponent(channel)}` +
      `&latest=${encodeURIComponent(messageTs)}` +
      `&inclusive=true&limit=1`;
    const historyRes = await fetch(historyUrl, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const history = (await historyRes.json()) as HistoryResponse;
    return history.messages?.[0]?.text?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Resolve the thread root ts for a reacted message.
 *
 * conversations.history does NOT return thread replies — reactions on thread
 * messages must use conversations.replies (see Slack API community workarounds).
 */
export async function resolveThreadRoot(
  env: Env,
  channel: string,
  messageTs: string,
): Promise<string> {
  try {
    const repliesUrl =
      `${SLACK_API}/conversations.replies` +
      `?channel=${encodeURIComponent(channel)}` +
      `&ts=${encodeURIComponent(messageTs)}` +
      `&inclusive=true&limit=1`;
    const repliesRes = await fetch(repliesUrl, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const replies = (await repliesRes.json()) as RepliesResponse;
    if (replies.ok && replies.messages?.[0]) {
      const msg = replies.messages[0];
      return msg.thread_ts ?? msg.ts ?? messageTs;
    }

    // Top-level channel message (not in a thread).
    const historyUrl =
      `${SLACK_API}/conversations.history` +
      `?channel=${encodeURIComponent(channel)}` +
      `&latest=${encodeURIComponent(messageTs)}` +
      `&inclusive=true&limit=1`;
    const historyRes = await fetch(historyUrl, {
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const history = (await historyRes.json()) as HistoryResponse;
    if (history.ok && history.messages?.[0]) {
      const msg = history.messages[0];
      return msg.thread_ts ?? msg.ts ?? messageTs;
    }

    console.warn('resolveThreadRoot failed', {
      repliesError: replies.error,
      historyError: history.error,
      channel,
      messageTs,
    });
    return messageTs;
  } catch (err) {
    console.warn('resolveThreadRoot error', { error: (err as Error).message });
    return messageTs;
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
