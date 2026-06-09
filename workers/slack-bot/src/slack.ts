/**
 * Slack interaction handling: `/ask-code` slash command and `app_mention`
 * events. Both ack immediately (within Slack's 3s window) and finish the work
 * asynchronously via ctx.waitUntil, posting the final answer back to Slack.
 */

import type { Env } from './env.js';
import { retrieve } from './retrieval/pipeline.js';
import { generateAnswer } from './llm.js';
import { buildAnswerMessage, type SlackMessage } from './format.js';

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
  event?: {
    type: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
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
  if (body.type === 'event_callback' && event?.type === 'app_mention') {
    // Ignore the bot's own messages to avoid loops.
    if (!event.bot_id && event.channel) {
      const question = stripMention(env, event.text ?? '');
      const channel = event.channel;
      const threadTs = event.thread_ts ?? event.ts;
      if (question) {
        ctx.waitUntil(answerToChannel(env, question, channel, threadTs));
      }
    }
  }

  return ackJson({ ok: true });
}

async function answerToChannel(
  env: Env,
  question: string,
  channel: string,
  threadTs: string | undefined,
): Promise<void> {
  const message = await buildAnswer(env, question);
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel,
      thread_ts: threadTs,
      text: message.text,
      blocks: message.blocks,
    }),
  });
}

// ---- Shared answer builder -------------------------------------------------

async function buildAnswer(env: Env, question: string): Promise<SlackMessage> {
  try {
    const outcome = await retrieve(env, question);
    const answer = await generateAnswer(env, question, outcome.packed);
    return buildAnswerMessage(question, answer.text, outcome.packed.citations);
  } catch (err) {
    return buildAnswerMessage(
      question,
      `Sorry — something went wrong answering that: ${(err as Error).message}`,
      [],
    );
  }
}

function stripMention(env: Env, text: string): string {
  let out = text;
  if (env.SLACK_BOT_USER_ID) {
    out = out.replaceAll(`<@${env.SLACK_BOT_USER_ID}>`, '');
  }
  out = out.replace(/<@[A-Z0-9]+>/g, '');
  return out.trim();
}
