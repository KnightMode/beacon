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
import { retrieveSmart } from './retrieval/pipeline.js';
import { streamAnswerTokens, NO_RESULTS_TEXT } from './llm.js';
import { buildCitationBlocks } from './format.js';
import { buildAnswer } from './answer.js';
import {
  fetchThreadHistory,
  buildRetrievalText,
  type Turn,
} from './history.js';

const SLACK_API = 'https://slack.com/api';
// Steady flush cadence for appendStream. Token reading and Slack writes are
// decoupled (reader fills a buffer, a timer drains it), so the stream renders
// at an even pace instead of bursting whenever the Slack API round trip ends.
const FLUSH_INTERVAL_MS = 250;

// The thinking status is updated at real stage transitions (understanding →
// searching → following the trail → drafting) instead of letting Slack cycle
// a canned list, so it progresses logically and never starts over.

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

  // Best-effort status shimmer, updated as the work actually progresses; it
  // auto-clears once the first stream chunk is sent.
  const setStatus = (status: string): void => {
    void call(env, 'assistant.threads.setStatus', {
      channel_id: t.channel,
      thread_ts: t.threadTs,
      status,
    }).catch(() => undefined);
  };
  setStatus('is reading your question…');

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
    const outcome = await retrieveSmart(env, t.question, searchText, setStatus);
    setStatus('is drafting a grounded answer…');

    if (outcome.packed.used.length === 0) {
      await write([markdown(NO_RESULTS_TEXT)]);
      await call(env, 'chat.stopStream', { channel: t.channel, ts });
      return;
    }

    let buffer = '';
    let fullText = '';
    let streamedAny = false;
    let producerDone = false;

    // Drain the buffer on a fixed cadence, independent of token arrival and
    // Slack API latency.
    const flusher = (async (): Promise<void> => {
      for (;;) {
        if (buffer) {
          const out = buffer;
          buffer = '';
          await write([markdown(out)]);
          streamedAny = true;
        } else if (producerDone) {
          return;
        }
        await new Promise((r) => setTimeout(r, FLUSH_INTERVAL_MS));
      }
    })();

    let producerErr: unknown;
    try {
      for await (const token of streamAnswerTokens(
        env,
        t.question,
        outcome.packed,
        history,
      )) {
        buffer += token;
        fullText += token;
      }
    } catch (err) {
      producerErr = err;
    } finally {
      producerDone = true;
    }
    await flusher;
    if (producerErr) throw producerErr;

    if (!streamedAny) {
      await write([markdown("I couldn't generate an answer from the indexed content.")]);
    }

    const blocks = buildCitationBlocks(outcome.packed.citations, fullText);
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
