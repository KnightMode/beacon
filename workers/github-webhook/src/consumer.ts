/**
 * Queue consumer: forwards each index job to an external Node runner.
 * Tree-sitter parsing must NOT run inside a Worker, so the heavy work lives in
 * the GitHub Actions indexer workflow by default, or an optional hosted indexer.
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
  // GitHub Actions remains the default runner. Tenant jobs include
  // installationId so the CLI mints a GitHub App installation token at runtime.
  if (env.PIPELINE_DISPATCH_REPO && env.PIPELINE_DISPATCH_TOKEN) {
    await dispatchToPipeline(env, job);
    return;
  }

  if (!env.INDEXER_URL || !env.INDEXER_SHARED_SECRET) {
    throw new Error(
      'index dispatch is not configured; set PIPELINE_DISPATCH_REPO/PIPELINE_DISPATCH_TOKEN or INDEXER_URL/INDEXER_SHARED_SECRET',
    );
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
        repoId: job.repoId,
        tenantId: job.tenantId ?? null,
        installationId: job.installationId ?? null,
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
