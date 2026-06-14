/**
 * Queue consumer: forwards each index job to an external Node runner.
 * Tree-sitter parsing must NOT run inside a Worker, so the heavy work lives in
 * the GitHub Actions indexer workflow by default, or an optional hosted indexer.
 */

import type { IndexJob } from '@scintel/shared';
import { createRepositoryDispatch } from '@scintel/shared';
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
  if (!env.PIPELINE_DISPATCH_REPO || !env.PIPELINE_DISPATCH_TOKEN) {
    throw new Error('repository_dispatch is not configured');
  }

  const res = await createRepositoryDispatch({
    repository: env.PIPELINE_DISPATCH_REPO,
    token: env.PIPELINE_DISPATCH_TOKEN,
    eventType: env.PIPELINE_DISPATCH_EVENT || 'index-repo',
    clientPayload: {
      repo: job.repoFullName,
      jobType: job.jobType,
      commitSha: job.commitSha ?? null,
      changedFiles: (job as { changedFiles?: string[] }).changedFiles ?? [],
      removedFiles: (job as { removedFiles?: string[] }).removedFiles ?? [],
      force: (job as { force?: boolean }).force ?? false,
      repoId: job.repoId,
      tenantId: job.tenantId ?? null,
      installationId: job.installationId ?? null,
    },
    userAgent: 'scintel-github-webhook',
  });
  // GitHub returns 204 No Content on success.
  if (!res.ok) {
    throw new Error(`repository_dispatch responded ${res.status}: ${res.body.slice(0, 500)}`);
  }
}
