/**
 * Slack Assistant (Agents & AI Apps) surface.
 *
 * When a user opens the assistant pane we offer suggested prompts. When they
 * send a message we show the native "thinking…" shimmer via
 * `assistant.threads.setStatus` (the glowing, rotating loading text), then
 * stream the grounded answer into the thread — sending the reply auto-clears
 * the shimmer.
 */

import type { Env } from './env.js';
import { call, monotonicStatus } from './stream.js';
import { buildAnswer } from './answer.js';
import { fetchThreadHistory } from './history.js';
import {
  detectIntent,
  stripCreatePrPrefix,
  parseIndexRepoTarget,
} from './intent.js';
import { handleAssistantPrReview } from './actions/prReview.js';
import { handleAssistantCreatePr } from './actions/createPr.js';
import { indexRepoAction, indexStatusAction } from './actions/indexRepo.js';

// Status text is updated at real stage transitions (no auto-cycling list).

export async function handleAssistantThreadStarted(
  env: Env,
  channelId: string,
  threadTs: string,
): Promise<void> {
  await call(env, 'assistant.threads.setSuggestedPrompts', {
    channel_id: channelId,
    thread_ts: threadTs,
    title: 'Ask about the codebase',
    prompts: [
      {
        title: 'Tree-sitter chunking',
        message: 'How does the indexer chunk code with tree-sitter?',
      },
      {
        title: 'Request signature verification',
        message: 'Where is the Slack request signature verified?',
      },
      {
        title: 'Retrieval pipeline',
        message: 'How does retrieval combine lexical, vector, and graph search?',
      },
      {
        title: 'Review a pull request',
        message: 'review https://github.com/owner/repo/pull/1',
      },
      {
        title: 'Open a pull request',
        message: 'create pr: add a short comment explaining thread memory in history.ts',
      },
    ],
  });
}

export interface AssistantMessage {
  channelId: string;
  threadTs: string;
  userId?: string;
  teamId?: string;
  text: string;
  messageTs?: string;
}

export async function handleAssistantMessage(
  env: Env,
  m: AssistantMessage,
): Promise<void> {
  const intent = detectIntent(m.text);
  if (intent === 'pr_review') {
    await call(env, 'assistant.threads.setStatus', {
      channel_id: m.channelId,
      thread_ts: m.threadTs,
      status: 'is reviewing…',
    });
    await handleAssistantPrReview(env, m);
    return;
  }
  if (intent === 'create_pr') {
    await handleAssistantCreatePr(env, {
      ...m,
      text: stripCreatePrPrefix(m.text),
    });
    return;
  }
  if (intent === 'index_repo' || intent === 'index_status') {
    let text: string;
    try {
      if (intent === 'index_status') {
        text = await indexStatusAction(env);
      } else {
        const repo = parseIndexRepoTarget(m.text);
        text = repo ? await indexRepoAction(env, repo) : 'Usage: `index owner/repo`';
      }
    } catch (err) {
      text = `:warning: Index action failed: ${(err as Error).message}`;
    }
    await call(env, 'chat.postMessage', {
      channel: m.channelId,
      thread_ts: m.threadTs,
      text,
    });
    return;
  }

  // Q&A runs on the answer queue when available — waitUntil gets cancelled
  // ~30s after the response, which can kill retrieval + answering mid-flight.
  // Show the status before enqueueing so the queue hop doesn't delay it.
  if (env.ANSWER_QUEUE) {
    await call(env, 'assistant.threads.setStatus', {
      channel_id: m.channelId,
      thread_ts: m.threadTs,
      status: 'is reading your question…',
    }).catch(() => undefined);
    await env.ANSWER_QUEUE.send({
      kind: 'assistant',
      channelId: m.channelId,
      threadTs: m.threadTs,
      text: m.text,
      userId: m.userId,
      teamId: m.teamId,
      messageTs: m.messageTs,
    });
    return;
  }
  await answerAssistantQuestion(env, m);
}

/** The actual assistant Q&A: staged status, retrieval + LLM, posted reply. */
export async function answerAssistantQuestion(
  env: Env,
  m: AssistantMessage,
): Promise<void> {
  // Status under the composer, advanced at real stage transitions; it clears
  // the moment we post the reply below. Monotonic: never repeats or cycles.
  const setStatus = monotonicStatus((status) => {
    void call(env, 'assistant.threads.setStatus', {
      channel_id: m.channelId,
      thread_ts: m.threadTs,
      status,
    }).catch(() => undefined);
  });
  setStatus('is reading your question…');

  const history = await fetchThreadHistory(
    env,
    m.channelId,
    m.threadTs,
    m.messageTs,
  ).catch(() => []);

  const message = await buildAnswer(env, m.text, history, setStatus);

  await call(env, 'chat.postMessage', {
    channel: m.channelId,
    thread_ts: m.threadTs,
    text: message.text,
    blocks: message.blocks,
  });
}
