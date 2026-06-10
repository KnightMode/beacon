/**
 * Slack interaction handling: `/ask-code` slash command and `app_mention`
 * events. Both ack immediately (within Slack's 3s window) and finish the work
 * asynchronously via ctx.waitUntil, posting the final answer back to Slack.
 */

import type { Env } from './env.js';
import { buildAnswer } from './answer.js';
import { streamAnswer } from './stream.js';
import {
  handleAssistantMessage,
  handleAssistantThreadStarted,
} from './assistant.js';
import { detectIntent, stripCreatePrPrefix } from './intent.js';
import { reviewToResponseUrl, streamPrReview } from './actions/prReview.js';
import {
  createPrFromThread,
  createPrSlashAck,
} from './actions/createPr.js';
import { handleReactionAdded } from './reactions.js';

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
        '• Describe an issue in a thread and react with :pr: to open a PR',
    });
  }

  const intent = detectIntent(question);
  if (intent === 'create_pr') {
    return ackJson({
      response_type: 'ephemeral',
      text: createPrSlashAck(),
    });
  }

  if (responseUrl) {
    ctx.waitUntil(
      intent === 'pr_review'
        ? reviewToResponseUrl(env, question, responseUrl)
        : answerToResponseUrl(env, question, responseUrl),
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

async function answerToResponseUrl(
  env: Env,
  question: string,
  responseUrl: string,
): Promise<void> {
  const message = await buildAnswer(env, question);
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...message, replace_original: false }),
  });
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
        } else {
          ctx.waitUntil(streamAnswer(env, target));
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
    if (re.user && re.reaction && re.item?.channel && re.item?.ts) {
      ctx.waitUntil(
        handleReactionAdded(env, {
          user: re.user,
          reaction: re.reaction,
          item: {
            type: re.item.type,
            channel: re.item.channel,
            ts: re.item.ts,
          },
        }),
      );
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
