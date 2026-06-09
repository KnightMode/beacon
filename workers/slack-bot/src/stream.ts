/**
 * Streaming Slack responses for channel @mentions (Agents & AI Apps).
 *
 * Flow: show the native glowing "is thinking…" shimmer via
 * assistant.threads.setStatus (works in channel threads when the Assistant
 * feature is enabled), then stream the answer in token-by-token with Slack's
 * native generating animation (no task cards) — sending the first chunk
 * auto-clears the shimmer — and finalize with citation blocks. Falls back to a
 * single non-streaming post if streaming can't even start.
 *
 * Only the chat:write scope is required for all of these methods.
 */

import type { Env } from './env.js';
import { retrieve } from './retrieval/pipeline.js';
import { streamAnswerTokens, NO_RESULTS_TEXT } from './llm.js';
import { buildCitationBlocks } from './format.js';
import { buildAnswer } from './answer.js';
import {
  fetchThreadHistory,
  buildRetrievalText,
  type Turn,
} from './history.js';

const SLACK_API = 'https://slack.com/api';
// Flush accumulated tokens to Slack roughly every this many chars to keep the
// stream smooth while staying well under the appendStream rate limit.
const FLUSH_CHARS = 90;

// Rotating lines for the glowing "thinking" shimmer shown while we work.
const LOADING_MESSAGES = [
  'Understanding your question…',
  'Searching indexed repositories…',
  'Reading the code graph…',
  'Pulling the most relevant snippets…',
  'Drafting a grounded answer…',
];

interface SlackResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

interface MarkdownChunk {
  type: 'markdown_text';
  text: string;
}

export interface StreamTarget {
  channel: string;
  threadTs: string;
  userId?: string;
  teamId?: string;
  question: string;
  messageTs?: string;
}

export async function call(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<SlackResult> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const result = (await res.json()) as SlackResult;
  if (!result.ok) {
    console.warn(`slack ${method} failed`, { error: result.error });
  }
  return result;
}

function markdown(text: string): MarkdownChunk {
  return { type: 'markdown_text', text };
}

/**
 * Streams an answer into a Slack thread as live markdown text. The stream is
 * opened lazily on the first write so the rendered message contains only the
 * answer (no leading status text), then closed with citation blocks.
 */
export async function streamAnswer(env: Env, t: StreamTarget): Promise<void> {
  let ts: string | undefined;

  // Show the glowing shimmer immediately (best-effort). It rotates through the
  // loading messages and auto-clears once the first stream chunk is sent.
  await call(env, 'assistant.threads.setStatus', {
    channel_id: t.channel,
    thread_ts: t.threadTs,
    status: 'is thinking…',
    loading_messages: LOADING_MESSAGES,
  }).catch(() => undefined);

  // Pull prior thread messages so follow-ups keep context. Gracefully empty if
  // the channels:history / groups:history scope is missing.
  const history = await fetchThreadHistory(
    env,
    t.channel,
    t.threadTs,
    t.messageTs,
  ).catch(() => []);

  const write = async (chunks: MarkdownChunk[]): Promise<void> => {
    if (!ts) {
      const started = await call(env, 'chat.startStream', {
        channel: t.channel,
        thread_ts: t.threadTs,
        recipient_user_id: t.userId,
        recipient_team_id: t.teamId,
        chunks,
      });
      if (!started.ok || !started.ts) {
        throw new Error(`startStream: ${started.error ?? 'unknown'}`);
      }
      ts = started.ts;
    } else {
      await call(env, 'chat.appendStream', { channel: t.channel, ts, chunks });
    }
  };

  try {
    const searchText = buildRetrievalText(history, t.question);
    const outcome = await retrieve(env, t.question, searchText);

    if (outcome.packed.used.length === 0) {
      await write([markdown(NO_RESULTS_TEXT)]);
      await call(env, 'chat.stopStream', { channel: t.channel, ts });
      return;
    }

    let buffer = '';
    let streamedAny = false;
    const flush = async (): Promise<void> => {
      if (!buffer) return;
      await write([markdown(buffer)]);
      buffer = '';
    };

    for await (const token of streamAnswerTokens(
      env,
      t.question,
      outcome.packed,
      history,
    )) {
      streamedAny = true;
      buffer += token;
      if (buffer.length >= FLUSH_CHARS) await flush();
    }
    await flush();

    if (!streamedAny) {
      await write([markdown("I couldn't generate an answer from the indexed content.")]);
    }

    const blocks = buildCitationBlocks(outcome.packed.citations);
    await call(env, 'chat.stopStream', {
      channel: t.channel,
      ts,
      ...(blocks.length ? { blocks } : {}),
    });
  } catch (err) {
    const message = (err as Error).message;
    if (ts) {
      await call(env, 'chat.stopStream', {
        channel: t.channel,
        ts,
        chunks: [markdown(`:warning: Something went wrong: ${message}`)],
      }).catch(() => undefined);
    } else {
      // Stream never opened — fall back to a normal post so the user still gets
      // an answer even when the streaming API is unavailable.
      console.warn('stream failed before start; falling back', { error: message });
      await fallback(env, t, history);
    }
  }
}

/** Non-streaming fallback: post the full formatted answer once. */
async function fallback(env: Env, t: StreamTarget, history: Turn[]): Promise<void> {
  const message = await buildAnswer(env, t.question, history);
  await call(env, 'chat.postMessage', {
    channel: t.channel,
    thread_ts: t.threadTs,
    text: message.text,
    blocks: message.blocks,
  });
}
