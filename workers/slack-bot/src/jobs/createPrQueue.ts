/**
 * Queue producer for create-PR jobs. Slack Events must ack within 3s, and
 * ctx.waitUntil() is capped at 30s — too short for retrieval + LLM + GitHub.
 * The queue consumer has up to 15 minutes wall time.
 */

import type { Env } from '../env.js';
import type { CreatePrTarget } from '../actions/createPr.js';
import { call } from '../stream.js';

export interface CreatePrJob extends CreatePrTarget {
  enqueuedAt: string;
}

export async function enqueueCreatePr(
  env: Env,
  target: CreatePrTarget,
): Promise<void> {
  if (!env.CREATE_PR_QUEUE) {
    throw new Error('CREATE_PR_QUEUE binding is not configured');
  }

  await call(env, 'chat.postMessage', {
    channel: target.channel,
    thread_ts: target.threadTs,
    text: ':hourglass_flowing_sand: Got it — drafting the pull request. This usually takes 1–2 minutes…',
  }).catch(() => undefined);

  const job: CreatePrJob = {
    ...target,
    enqueuedAt: new Date().toISOString(),
  };
  await env.CREATE_PR_QUEUE.send(job);
  console.log('create-pr enqueued', {
    channel: target.channel,
    threadTs: target.threadTs,
  });
}
