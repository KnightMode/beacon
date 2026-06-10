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
  // Prefer the GitHub Actions pipeline when configured: fire a
  // repository_dispatch that runs the indexer CLI in CI. Falls back to the
  // direct INDEXER_URL POST when pipeline dispatch is not configured.
  if (env.PIPELINE_DISPATCH_REPO && env.PIPELINE_DISPATCH_TOKEN) {
    await dispatchToPipeline(env, job);
    return;
  }

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

async function dispatchToPipeline(env: Env, job: IndexJob): Promise<void> {
  const url = `https://api.github.com/repos/${env.PIPELINE_DISPATCH_REPO}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.PIPELINE_DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'scintel-github-webhook',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      event_type: env.PIPELINE_DISPATCH_EVENT || 'index-repo',
      client_payload: {
        repo: job.repoFullName,
        jobType: job.jobType,
        commitSha: job.commitSha ?? null,
        changedFiles: (job as { changedFiles?: string[] }).changedFiles ?? [],
        removedFiles: (job as { removedFiles?: string[] }).removedFiles ?? [],
        force: (job as { force?: boolean }).force ?? false,
      },
    }),
  });
  // GitHub returns 204 No Content on success.
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`repository_dispatch responded ${res.status}: ${text.slice(0, 500)}`);
  }
}
