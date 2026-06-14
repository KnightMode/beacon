/**
 * Queue producer helpers: build and enqueue index jobs.
 */

import {
  JOB_TYPES,
  type FullIndexJob,
  type IncrementalIndexJob,
  type TriageJob,
} from '@scintel/shared';
import type { Env } from './env.js';
import { setIndexStatus, repoIdFor, getSlackTeamIdsForRepo } from './db.js';
import type { WorkflowRunPayload } from './webhook.js';

export async function enqueueFullIndex(
  env: Env,
  repoId: string,
  repoFullName: string,
  commitSha?: string,
  installationId?: number,
): Promise<void> {
  const job: FullIndexJob = {
    jobType: JOB_TYPES.FULL_INDEX,
    repoId,
    repoFullName,
    commitSha,
    installationId,
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
  installationId?: number,
): Promise<void> {
  const job: IncrementalIndexJob = {
    jobType: JOB_TYPES.INCREMENTAL_INDEX,
    repoId,
    repoFullName,
    commitSha,
    changedFiles,
    removedFiles,
    installationId,
    enqueuedAt: new Date().toISOString(),
  };
  await env.INDEX_QUEUE.send(job);
  await setIndexStatus(env, repoId, 'PENDING', JOB_TYPES.INCREMENTAL_INDEX);
}

export async function enqueueTriage(
  env: Env,
  payload: WorkflowRunPayload,
): Promise<void> {
  const run = payload.workflow_run;
  const repoId = repoIdFor(payload.repository.full_name);
  const slackTeamIds = await getSlackTeamIdsForRepo(env, repoId);
  const teams = slackTeamIds.length > 0 ? slackTeamIds : [undefined];

  await Promise.all(
    teams.map((slackTeamId) =>
      env.TRIAGE_QUEUE.send({
        jobType: 'CI_TRIAGE',
        repoId,
        repoFullName: payload.repository.full_name,
        runId: run.id,
        runAttempt: run.run_attempt ?? 1,
        workflowName: run.name,
        headBranch: run.head_branch,
        headSha: run.head_sha,
        runHtmlUrl: run.html_url,
        slackTeamId,
        enqueuedAt: new Date().toISOString(),
      } satisfies TriageJob),
    ),
  );
}
