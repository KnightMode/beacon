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
      text: 'Usage: `/ask-code <your question about the codebase>`',
    });
  }

  if (responseUrl) {
    ctx.waitUntil(answerToResponseUrl(env, question, responseUrl));
  }

  return ackJson({
    response_type: 'ephemeral',
    text: ':mag: Searching indexed repos…',
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
        ctx.waitUntil(
          streamAnswer(env, {
            channel: event.channel,
            threadTs,
            userId: event.user,
            teamId: body.team_id ?? event.team,
            question,
          }),
        );
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
