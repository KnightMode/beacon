/**
 * Slack interaction handling: `/ask-code` slash command and `app_mention`
 * events. Both ack immediately (within Slack's 3s window) and finish the work
 * asynchronously via ctx.waitUntil, posting the final answer back to Slack.
 */

import type { Env } from './env.js';
import {
  handleAssistantMessage,
  handleAssistantThreadStarted,
} from './assistant.js';
import {
  detectIntent,
  stripCreatePrPrefix,
  parseIndexRepoTarget,
} from './intent.js';
import { indexRepoAction, indexStatusAction } from './actions/indexRepo.js';
import { call } from './stream.js';
import { enqueueAnswer } from './jobs/answerQueue.js';
import { reviewToResponseUrl, streamPrReview } from './actions/prReview.js';
import {
  createPrFromThread,
  createPrSlashAck,
} from './actions/createPr.js';
import { handleReactionAdded } from './reactions.js';
import { reactionsSetupChecklist } from './reactionsSetup.js';

export function ackJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- Slash command ---------------------------------------------------------

export function handleSlashCommand(
  env: Env,
  ctx: ExecutionContext,
  params: URLSearchParams,
): Response {
  const question = (params.get('text') ?? '').trim();
  const responseUrl = params.get('response_url');

  if (!question) {
    return ackJson({
      response_type: 'ephemeral',
      text:
        'Usage:\n' +
        '• `/ask-code <question>` — search indexed repos\n' +
        '• `/ask-code review <pr-url>` — review a pull request\n' +
        '• `/ask-code reactions` — emoji reaction setup checklist\n' +
        '• Describe an issue in a thread and react with :rocket: to open a PR',
    });
  }

  if (/^reactions?\b/i.test(question)) {
    return ackJson({
      response_type: 'ephemeral',
      text: reactionsSetupChecklist(),
    });
  }

  const intent = detectIntent(question);
  if (intent === 'create_pr') {
    return ackJson({
      response_type: 'ephemeral',
      text: createPrSlashAck(),
    });
  }

  if (intent === 'index_repo' || intent === 'index_status') {
    if (responseUrl) {
      ctx.waitUntil(indexActionToResponseUrl(env, intent, question, responseUrl));
    }
    return ackJson({
      response_type: 'ephemeral',
      text:
        intent === 'index_repo'
          ? ':hammer_and_wrench: Starting indexing…'
          : ':mag: Checking index status…',
    });
  }

  if (responseUrl) {
    ctx.waitUntil(
      intent === 'pr_review'
        ? reviewToResponseUrl(env, question, responseUrl)
        : enqueueAnswer(env, { kind: 'response_url', question, responseUrl }),
    );
  }

  return ackJson({
    response_type: 'ephemeral',
    text:
      intent === 'pr_review'
        ? ':mag: Reviewing pull request…'
        : ':mag: Searching indexed repos…',
  });
}

async function indexActionToResponseUrl(
  env: Env,
  intent: 'index_repo' | 'index_status',
  question: string,
  responseUrl: string,
): Promise<void> {
  const text = await runIndexAction(env, intent, question);
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'in_channel', text }),
  });
}

async function runIndexAction(
  env: Env,
  intent: 'index_repo' | 'index_status',
  text: string,
): Promise<string> {
  try {
    if (intent === 'index_status') return await indexStatusAction(env);
    const repo = parseIndexRepoTarget(text);
    if (!repo) return 'Usage: `index owner/repo`';
    return await indexRepoAction(env, repo);
  } catch (err) {
    return `:warning: Index action failed: ${(err as Error).message}`;
  }
}

// ---- Events (app_mention + url_verification) -------------------------------

interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  team_id?: string;
  event?: {
    type: string;
    subtype?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    user?: string;
    team?: string;
    assistant_thread?: {
      channel_id?: string;
      thread_ts?: string;
    };
  };
  event_id?: string;
}

interface ReactionAddedEvent {
  type: 'reaction_added';
  user: string;
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
}

export function handleEvent(
  env: Env,
  ctx: ExecutionContext,
  body: SlackEventEnvelope,
): Response {
  if (body.type === 'url_verification') {
    return ackJson({ challenge: body.challenge });
  }

  const event = body.event;
  if (body.type !== 'event_callback' || !event) {
    return ackJson({ ok: true });
  }

  // Channel @mention → stream into the channel thread.
  if (event.type === 'app_mention') {
    if (!event.bot_id && event.channel) {
      const question = stripMention(env, event.text ?? '');
      const threadTs = event.thread_ts ?? event.ts;
      if (question && threadTs) {
        const target = {
          channel: event.channel,
          threadTs,
          userId: event.user,
          teamId: body.team_id ?? event.team,
          question,
          messageTs: event.ts,
        };
        const intent = detectIntent(question);
        if (intent === 'create_pr') {
          ctx.waitUntil(
            createPrFromThread(env, {
              channel: event.channel,
              threadTs,
              userId: event.user,
              messageTs: event.ts,
              issueHint: stripCreatePrPrefix(question),
            }),
          );
        } else if (intent === 'pr_review') {
          ctx.waitUntil(streamPrReview(env, target));
        } else if (intent === 'index_repo' || intent === 'index_status') {
          ctx.waitUntil(
            runIndexAction(env, intent, question).then((text) =>
              call(env, 'chat.postMessage', {
                channel: event.channel,
                thread_ts: threadTs,
                text,
              }).then(() => undefined),
            ),
          );
        } else {
          // Show the thinking status immediately from the event handler so
          // the queue hop doesn't delay the first visible feedback.
          ctx.waitUntil(
            call(env, 'assistant.threads.setStatus', {
              channel_id: event.channel,
              thread_ts: threadTs,
              status: 'is reading your question…',
            })
              .catch(() => undefined)
              .then(() => enqueueAnswer(env, { kind: 'stream', ...target })),
          );
        }
      }
    }
    return ackJson({ ok: true });
  }

  // Assistant pane opened → offer suggested prompts.
  if (event.type === 'assistant_thread_started') {
    const at = event.assistant_thread;
    if (at?.channel_id && at.thread_ts) {
      ctx.waitUntil(
        handleAssistantThreadStarted(env, at.channel_id, at.thread_ts),
      );
    }
    return ackJson({ ok: true });
  }

  // Emoji reaction on a message → agent action without @mention.
  if (event.type === 'reaction_added') {
    const re = event as unknown as ReactionAddedEvent;
    console.log('slack event reaction_added', {
      reaction: re.reaction,
      hasItem: Boolean(re.item),
      channel: re.item?.channel,
      ts: re.item?.ts,
    });
    if (re.user && re.reaction && re.item?.channel && re.item?.ts) {
      ctx.waitUntil(
        handleReactionAdded(env, {
          user: re.user,
          reaction: re.reaction,
          teamId: body.team_id ?? event.team,
          item: {
            type: re.item.type ?? 'message',
            channel: re.item.channel,
            ts: re.item.ts,
          },
        }),
      );
    } else {
      console.warn('reaction_added missing fields', { user: re.user, reaction: re.reaction });
    }
    return ackJson({ ok: true });
  }

  // User message in the assistant pane / DM → shimmer + streamed answer.
  if (
    event.type === 'message' &&
    !event.bot_id &&
    !event.subtype &&
    event.channel_type === 'im' &&
    event.channel &&
    event.text
  ) {
    const threadTs = event.thread_ts ?? event.ts;
    if (threadTs) {
      ctx.waitUntil(
        handleAssistantMessage(env, {
          channelId: event.channel,
          threadTs,
          userId: event.user,
          teamId: body.team_id ?? event.team,
          text: event.text,
          messageTs: event.ts,
        }),
      );
    }
    return ackJson({ ok: true });
  }

  return ackJson({ ok: true });
}

function stripMention(env: Env, text: string): string {
  let out = text;
  if (env.SLACK_BOT_USER_ID) {
    out = out.replaceAll(`<@${env.SLACK_BOT_USER_ID}>`, '');
  }
  out = out.replace(/<@[A-Z0-9]+>/g, '');
  return out.trim();
}
