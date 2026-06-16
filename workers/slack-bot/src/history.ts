/**
 * Thread history ("conversation memory"): fetches prior messages from a Slack
 * thread and shapes them into compact conversation turns so follow-up questions
 * retain context instead of being answered in isolation.
 *
 * Always degrades gracefully: if conversations.replies fails (e.g. a missing
 * channels:history / groups:history scope, or a deleted thread) we log a warning
 * and return an empty history so behavior matches the stateless path.
 */

import type { Env } from './env.js';
import { slackGet } from './slackClient.js';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

const MAX_TURNS = 8;
const USER_TRUNCATE = 800;
const ASSISTANT_TRUNCATE = 1200;

interface SlackReply {
  ts?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  app_id?: string;
}

interface RepliesResponse {
  ok: boolean;
  error?: string;
  messages?: SlackReply[];
}

// Slack message subtypes that represent system/join noise rather than real
// conversation content. These are skipped entirely.
const SYSTEM_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
]);

/**
 * Fetch the last messages in a thread and shape them into conversation turns.
 * Uses the read (GET) form of conversations.replies. Never throws.
 */
export async function fetchThreadHistory(
  env: Env,
  channel: string,
  threadTs: string,
  excludeTs?: string,
  teamId?: string,
): Promise<Turn[]> {
  try {
    const data = await slackGet<RepliesResponse>(
      env,
      'conversations.replies',
      { channel, ts: threadTs, limit: 20 },
      teamId,
    );

    if (!data.ok) {
      console.warn('conversations.replies failed', { error: data.error });
      return [];
    }

    const turns: Turn[] = [];
    for (const msg of data.messages ?? []) {
      if (excludeTs && msg.ts === excludeTs) continue;
      if (msg.subtype && SYSTEM_SUBTYPES.has(msg.subtype)) continue;

      const isAssistant = Boolean(
        msg.bot_id || msg.app_id || msg.subtype === 'bot_message',
      );
      const role: Turn['role'] = isAssistant ? 'assistant' : 'user';
      const text = cleanText(msg.text ?? '', role);
      if (!text) continue;

      turns.push({ role, text });
    }

    return turns.slice(-MAX_TURNS);
  } catch (err) {
    console.warn('fetchThreadHistory error', { error: (err as Error).message });
    return [];
  }
}

function cleanText(raw: string, role: Turn['role']): string {
  let text = raw.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return '';

  if (role === 'assistant') {
    // Drop a leading "*Q:* ..." line the bot prefixes some answers with.
    return truncate(cleanAssistantText(text), ASSISTANT_TRUNCATE);
  }

  return truncate(text, USER_TRUNCATE);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Builds the text used for retrieval. For follow-ups we prepend the most recent
 * previous user turn so vague questions ("what about errors?") inherit the
 * subject of the conversation. The LLM still receives the real question
 * separately.
 */
export function buildRetrievalText(history: Turn[], question: string): string {
  let prevUser: string | undefined;
  let prevAssistant: string | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn && turn.role === 'user') {
      prevUser = turn.text;
      if (prevAssistant) break;
    } else if (turn && turn.role === 'assistant') {
      prevAssistant ??= cleanAssistantText(turn.text);
    }
  }
  return [prevUser, prevAssistant, question].filter(Boolean).join(' ').trim();
}

function cleanAssistantText(raw: string): string {
  let text = raw.replace(/^\*Q:\*[^\n]*\n+/, '');
  // Strip bracketed citation markers like [1], [2], [1][3].
  text = text.replace(/\[\d+\]/g, '').trim();
  // Keep follow-up retrieval focused on answer content, not old source lists.
  text = text.split(/\n\s*\*?Sources\*?\s*\n/i)[0]?.trim() ?? text;
  text = text.split(/\n\s*:robot_face:/i)[0]?.trim() ?? text;
  return text;
}
