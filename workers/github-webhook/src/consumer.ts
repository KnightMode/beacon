/**
 * Queue consumer: forwards each index job to the standalone indexer HTTP
 * service. Tree-sitter parsing must NOT run inside a Worker, so the heavy work
 * lives in the Node indexer; this consumer is a thin, retrying dispatcher.
 */

import type { IndexJob } from '@scintel/shared';
import type { Env } from './env.js';

export async function handleIndexBatch(
  batch: MessageBatch<IndexJob>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await dispatchToIndexer(env, message.body);
      message.ack();
    } catch (err) {
      console.error('index job failed, will retry', {
        repo: message.body.repoFullName,
        error: (err as Error).message,
      });
      message.retry();
    }
  }
}

async function dispatchToIndexer(env: Env, job: IndexJob): Promise<void> {
  const url = `${env.INDEXER_URL.replace(/\/$/, '')}/index`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.INDEXER_SHARED_SECRET}`,
    },
    body: JSON.stringify(job),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`indexer responded ${res.status}: ${text.slice(0, 500)}`);
  }
}
