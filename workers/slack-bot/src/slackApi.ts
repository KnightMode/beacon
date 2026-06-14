/**
 * Slack Web API helpers shared by history, reactions, and thread actions.
 */

import type { Env } from './env.js';
import { fetchThreadHistory, type Turn } from './history.js';
import { slackGet } from './slackClient.js';

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

interface PermalinkResponse {
  ok: boolean;
  error?: string;
  permalink?: string;
}

/** Fetch the text of a single message by ts (works for thread replies). */
export async function fetchMessageText(
  env: Env,
  channel: string,
  messageTs: string,
  teamId?: string,
): Promise<string> {
  try {
    const replies = await slackGet<RepliesResponse>(
      env,
      'conversations.replies',
      { channel, ts: messageTs, inclusive: true, limit: 1 },
      teamId,
    );
    if (replies.ok && replies.messages?.[0]?.text) {
      return replies.messages[0].text.trim();
    }

    const history = await slackGet<HistoryResponse>(
      env,
      'conversations.history',
      { channel, latest: messageTs, inclusive: true, limit: 1 },
      teamId,
    );
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
  teamId?: string,
): Promise<string> {
  try {
    const replies = await slackGet<RepliesResponse>(
      env,
      'conversations.replies',
      { channel, ts: messageTs, inclusive: true, limit: 1 },
      teamId,
    );
    if (replies.ok && replies.messages?.[0]) {
      const msg = replies.messages[0];
      return msg.thread_ts ?? msg.ts ?? messageTs;
    }

    // Top-level channel message (not in a thread).
    const history = await slackGet<HistoryResponse>(
      env,
      'conversations.history',
      { channel, latest: messageTs, inclusive: true, limit: 1 },
      teamId,
    );
    if (history.ok && history.messages?.[0]) {
      const msg = history.messages[0];
      return msg.thread_ts ?? msg.ts ?? messageTs;
    }

    const link = await slackGet<PermalinkResponse>(
      env,
      'chat.getPermalink',
      { channel, message_ts: messageTs },
      teamId,
    );
    if (link.ok && link.permalink) {
      try {
        const threadFromUrl = new URL(link.permalink).searchParams.get('thread_ts');
        if (threadFromUrl) return threadFromUrl;
      } catch {
        // ignore bad URL
      }
    }

    console.warn('resolveThreadRoot failed', {
      repliesError: replies.error,
      historyError: history.error,
      permalinkError: link.error,
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
  teamId?: string,
): Promise<string> {
  const turns = await fetchThreadHistory(env, channel, threadTs, undefined, teamId);
  const userLines = turns.filter((t) => t.role === 'user').map((t) => t.text);
  if (userLines.length === 0) return '';
  return userLines.join('\n\n');
}

export function formatThreadForDisplay(turns: Turn[]): string {
  return turns.map((t) => `*${t.role}:* ${t.text}`).join('\n\n');
}
