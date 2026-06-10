/**
 * Emoji reaction triggers for agent actions. React on a message to invoke the
 * bot without an @mention.
 *
 * Default mapping:
 *   :pr: / :rocket:  → create a GitHub PR from the thread issue description
 *   :mag: / :eyes:   → review a PR (if URL in message) or answer the thread
 */

import type { Env } from './env.js';
import { parsePrReference } from './intent.js';
import { fetchMessageText, resolveThreadRoot } from './slackApi.js';
import { call } from './stream.js';
import { createPrFromThread } from './actions/createPr.js';
import { streamPrReview } from './actions/prReview.js';
import { streamAnswer } from './stream.js';
import { fetchThreadHistory } from './history.js';

/** Slack reaction names (without colons). */
export const CREATE_PR_REACTIONS = new Set(['pr', 'rocket']);
export const REVIEW_REACTIONS = new Set(['mag', 'eyes']);
export const ANSWER_REACTIONS = new Set(['robot_face', 'thinking_face']);

/** Strip skin-tone / alias suffixes (e.g. `thumbsup::skin-tone-2` → `thumbsup`). */
export function normalizeReactionName(reaction: string): string {
  return reaction.toLowerCase().split('::')[0] ?? reaction.toLowerCase();
}

export function reactionAction(
  reaction: string,
): 'create_pr' | 'pr_review' | 'answer' | null {
  const r = normalizeReactionName(reaction);
  if (CREATE_PR_REACTIONS.has(r)) return 'create_pr';
  if (REVIEW_REACTIONS.has(r)) return 'pr_review';
  if (ANSWER_REACTIONS.has(r)) return 'answer';
  return null;
}

export interface ReactionEvent {
  user: string;
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
}

export async function handleReactionAdded(
  env: Env,
  event: ReactionEvent,
): Promise<void> {
  console.log('reaction_added', {
    reaction: event.reaction,
    channel: event.item.channel,
    ts: event.item.ts,
    user: event.user,
  });

  if (event.item.type !== 'message') {
    console.warn('reaction_added ignored: item is not a message', {
      type: event.item.type,
    });
    return;
  }

  const action = reactionAction(event.reaction);
  if (!action) {
    console.log('reaction_added ignored: unmapped emoji', {
      reaction: event.reaction,
      normalized: normalizeReactionName(event.reaction),
    });
    return;
  }

  // Ignore the bot reacting to itself (when SLACK_BOT_USER_ID is configured).
  if (env.SLACK_BOT_USER_ID && event.user === env.SLACK_BOT_USER_ID) return;

  const channel = event.item.channel;
  const threadTs = await resolveThreadRoot(env, channel, event.item.ts);

  // Immediate ack — if you never see this, Slack is not delivering reaction_added.
  const ack = await call(env, 'chat.postMessage', {
    channel,
    thread_ts: threadTs,
    text: `:${normalizeReactionName(event.reaction)}: received — working on it…`,
  });
  if (!ack.ok) {
    console.error('reaction ack postMessage failed', {
      error: ack.error,
      channel,
      threadTs,
    });
  }

  switch (action) {
    case 'create_pr': {
      const issue = await fetchMessageText(env, channel, event.item.ts);
      await createPrFromThread(env, {
        channel,
        threadTs,
        userId: event.user,
        messageTs: event.item.ts,
        issueHint: issue || undefined,
      });
      return;
    }

    case 'pr_review': {
      const anchor = await fetchMessageText(env, channel, event.item.ts);
      const turns = await fetchThreadHistory(env, channel, threadTs, event.item.ts);
      const threadText = turns
        .filter((t) => t.role === 'user')
        .map((t) => t.text)
        .join('\n');
      const ref = parsePrReference(anchor) ?? parsePrReference(threadText);
      if (ref) {
        await streamPrReview(env, {
          channel,
          threadTs,
          userId: event.user,
          question: `review ${ref.url}`,
          messageTs: event.item.ts,
        });
      } else {
        const question =
          anchor ||
          turns.filter((t) => t.role === 'user').at(-1)?.text ||
          'Summarize this thread';
        await streamAnswer(env, {
          channel,
          threadTs,
          userId: event.user,
          question,
          messageTs: event.item.ts,
        });
      }
      return;
    }

    case 'answer': {
      const turns = await fetchThreadHistory(env, channel, threadTs, event.item.ts);
      const question =
        turns.filter((t) => t.role === 'user').at(-1)?.text ?? 'What is this about?';
      await streamAnswer(env, {
        channel,
        threadTs,
        userId: event.user,
        question,
        messageTs: event.item.ts,
      });
      return;
    }

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
