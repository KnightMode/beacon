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
import { createPrFromThread } from './actions/createPr.js';
import { streamPrReview } from './actions/prReview.js';
import { streamAnswer } from './stream.js';
import { fetchThreadHistory } from './history.js';

/** Slack reaction names (without colons). */
export const CREATE_PR_REACTIONS = new Set(['pr', 'rocket']);
export const REVIEW_REACTIONS = new Set(['mag', 'eyes']);
export const ANSWER_REACTIONS = new Set(['robot_face', 'thinking_face']);

export function reactionAction(
  reaction: string,
): 'create_pr' | 'pr_review' | 'answer' | null {
  const r = reaction.toLowerCase();
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
  if (event.item.type !== 'message') return;

  const action = reactionAction(event.reaction);
  if (!action) return;

  // Ignore the bot reacting to itself.
  if (event.user === env.SLACK_BOT_USER_ID) return;

  const threadTs = await resolveThreadRoot(env, event.item.channel, event.item.ts);
  if (!threadTs) return;

  const channel = event.item.channel;

  switch (action) {
    case 'create_pr':
      await createPrFromThread(env, { channel, threadTs, userId: event.user });
      return;

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
