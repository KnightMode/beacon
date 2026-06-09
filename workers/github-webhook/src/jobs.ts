/**
 * Queue producer helpers: build and enqueue index jobs.
 */

import {
  JOB_TYPES,
  type FullIndexJob,
  type IncrementalIndexJob,
} from '@scintel/shared';
import type { Env } from './env.js';
import { setIndexStatus } from './db.js';

export async function enqueueFullIndex(
  env: Env,
  repoId: string,
  repoFullName: string,
  commitSha?: string,
): Promise<void> {
  const job: FullIndexJob = {
    jobType: JOB_TYPES.FULL_INDEX,
    repoId,
    repoFullName,
    commitSha,
    enqueuedAt: new Date().toISOString(),
  };
  await env.INDEX_QUEUE.send(job);
  await setIndexStatus(env, repoId, 'PENDING', JOB_TYPES.FULL_INDEX);
}

export async function enqueueIncrementalIndex(
  env: Env,
  repoId: string,
  repoFullName: string,
  changedFiles: string[],
  removedFiles: string[],
  commitSha?: string,
): Promise<void> {
  const job: IncrementalIndexJob = {
    jobType: JOB_TYPES.INCREMENTAL_INDEX,
    repoId,
    repoFullName,
    commitSha,
    changedFiles,
    removedFiles,
    enqueuedAt: new Date().toISOString(),
  };
  await env.INDEX_QUEUE.send(job);
  await setIndexStatus(env, repoId, 'PENDING', JOB_TYPES.INCREMENTAL_INDEX);
}
