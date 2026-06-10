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
import { call } from './stream.js';
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

const LOADING_MESSAGES = [
  'Understanding your question…',
  'Searching indexed repositories…',
  'Reading the code graph…',
  'Pulling the most relevant snippets…',
  'Drafting a grounded answer…',
];

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
      loading_messages: LOADING_MESSAGES,
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

  // Show the glowing, rotating "thinking" indicator under the composer. It
  // stays up (rotating through LOADING_MESSAGES) for the whole retrieval + LLM
  // run, then clears the moment we post the reply below.
  await call(env, 'assistant.threads.setStatus', {
    channel_id: m.channelId,
    thread_ts: m.threadTs,
    status: 'is thinking…',
    loading_messages: LOADING_MESSAGES,
  });

  const history = await fetchThreadHistory(
    env,
    m.channelId,
    m.threadTs,
    m.messageTs,
  ).catch(() => []);

  const message = await buildAnswer(env, m.text, history);

  await call(env, 'chat.postMessage', {
    channel: m.channelId,
    thread_ts: m.threadTs,
    text: message.text,
    blocks: message.blocks,
  });
}
