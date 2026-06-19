/**
 * CI-failure triage consumer (queue: scintel-triage-jobs, produced by the
 * github-webhook worker on workflow_run failures).
 *
 * Deterministic gates run before any LLM call: a claim row dedupes webhook
 * redeliveries, unmapped repos exit before touching GitHub, and transient
 * failure signatures get a short note instead of a triage — the LLM only
 * explains failures the gates say are worth explaining. PR creation stays
 * human-gated: the posted message invites a :rocket: reaction, which flows
 * through the existing reaction → createPrFromThread path.
 */

import { parseRepoRef, type Citation, type TriageJob } from '@scintel/shared';
import type { Env } from '../env.js';
import { GitHubClient, type CommitDiff } from '../github.js';
import { retrieveSmart } from '../retrieval/pipeline.js';
import { generateTriage } from '../llm/triage.js';
import {
  classifyTransient,
  extractErrorExcerpt,
  harvestPaths,
  topErrorLine,
} from '../ci/logExcerpt.js';
import {
  buildTransientMessage,
  buildTriageMessage,
  type TriageMessage,
} from '../ci/triageMessage.js';
import { getNotifyChannel } from '../notifyChannels.js';
import { call } from '../stream.js';

const EXCERPT_BUDGET = 8_000;
const DIFF_BUDGET = 6_000;
const MAX_FAILED_JOBS = 2;

export async function processTriageJob(env: Env, job: TriageJob): Promise<void> {
  // Claim before doing any work. Tenant-scoped jobs dedupe per Slack workspace;
  // Legacy non-tenant jobs keep the original global (run, attempt) claim.
  const claimed = await claimTriageRun(env, job);
  if (!claimed) {
    console.log('ci triage: duplicate run, skipping', {
      repo: job.repoFullName,
      runId: job.runId,
      runAttempt: job.runAttempt,
      slackTeamId: job.slackTeamId,
    });
    return;
  }

  try {
    const channel = await getNotifyChannel(env, job.repoId, job.slackTeamId);
    if (!channel) {
      console.log('ci triage: no notify channel mapped, skipping', {
        repo: job.repoFullName,
        slackTeamId: job.slackTeamId,
      });
      return;
    }

    const gh = await GitHubClient.forTenantRepo(env, job.slackTeamId, job.repoFullName);
    if (!gh) {
      console.warn('ci triage: GitHub App access not configured, skipping', {
        repo: job.repoFullName,
        slackTeamId: job.slackTeamId,
      });
      return;
    }

    const message = await buildMessage(env, gh, job);
    const res = await call(env, 'chat.postMessage', {
      channel,
      text: message.text,
      blocks: message.blocks,
    }, job.slackTeamId);
    if (!res.ok) {
      throw new Error(`chat.postMessage failed: ${res.error ?? 'unknown'}`);
    }
    await markTriagePosted(env, job, res.ts ?? 'posted');
  } catch (err) {
    // Release the claim so a queue retry can reprocess; keep it when the
    // message was already posted (message_ts set) to avoid double posts.
    await releaseTriageClaim(env, job).catch(() => undefined);
    throw err;
  }
}

async function claimTriageRun(env: Env, job: TriageJob): Promise<boolean> {
  const claim = job.slackTeamId
    ? await env.DB.prepare(
        `INSERT INTO tenant_ci_triage_runs (run_id, run_attempt, slack_team_id, repo_id)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (run_id, run_attempt, slack_team_id) DO NOTHING`,
      )
        .bind(job.runId, job.runAttempt, job.slackTeamId, job.repoId)
        .run()
    : await env.DB.prepare(
        `INSERT INTO ci_triage_runs (run_id, run_attempt, repo_id)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (run_id, run_attempt) DO NOTHING`,
      )
        .bind(job.runId, job.runAttempt, job.repoId)
        .run();
  return (claim.meta?.changes ?? 0) > 0;
}

async function markTriagePosted(
  env: Env,
  job: TriageJob,
  messageTs: string,
): Promise<void> {
  if (job.slackTeamId) {
    await env.DB.prepare(
      `UPDATE tenant_ci_triage_runs SET message_ts = ?4
       WHERE run_id = ?1 AND run_attempt = ?2 AND slack_team_id = ?3`,
    )
      .bind(job.runId, job.runAttempt, job.slackTeamId, messageTs)
      .run();
    return;
  }

  await env.DB.prepare(
    `UPDATE ci_triage_runs SET message_ts = ?3
     WHERE run_id = ?1 AND run_attempt = ?2`,
  )
    .bind(job.runId, job.runAttempt, messageTs)
    .run();
}

async function releaseTriageClaim(env: Env, job: TriageJob): Promise<void> {
  if (job.slackTeamId) {
    await env.DB.prepare(
      `DELETE FROM tenant_ci_triage_runs
       WHERE run_id = ?1 AND run_attempt = ?2 AND slack_team_id = ?3
         AND message_ts IS NULL`,
    )
      .bind(job.runId, job.runAttempt, job.slackTeamId)
      .run();
    return;
  }

  await env.DB.prepare(
    `DELETE FROM ci_triage_runs
     WHERE run_id = ?1 AND run_attempt = ?2 AND message_ts IS NULL`,
  )
    .bind(job.runId, job.runAttempt)
    .run();
}


async function buildMessage(
  env: Env,
  gh: GitHubClient,
  job: TriageJob,
): Promise<TriageMessage> {
  const repo = parseRepoRef(job.repoFullName);
  if (!repo) {
    throw new Error(`invalid repo full name: ${job.repoFullName}`);
  }

  const runJobs = await gh.getWorkflowRunJobs(
    repo.owner,
    repo.name,
    job.runId,
    job.runAttempt,
  );
  const failedJobs = runJobs.filter((j) => j.conclusion === 'failure');

  const failedSteps: string[] = [];
  const excerpts: string[] = [];
  const jobsToFetch = failedJobs.slice(0, MAX_FAILED_JOBS);
  const logResults = await Promise.all(
    jobsToFetch.map(async (fj) => {
      const steps = fj.steps
        .filter((s) => s.conclusion === 'failure')
        .map((s) => `${fj.name} › ${s.name}`);
      try {
        const log = await gh.getJobLogs(repo.owner, repo.name, fj.id);
        return {
          steps: steps.length > 0 ? steps : [fj.name],
          excerpt: extractErrorExcerpt(log, EXCERPT_BUDGET),
        };
      } catch (err) {
        console.warn('ci triage: job log fetch failed', {
          repo: job.repoFullName,
          jobId: fj.id,
          error: (err as Error).message,
        });
        return { steps: steps.length > 0 ? steps : [fj.name], excerpt: '' };
      }
    }),
  );
  for (const result of logResults) {
    failedSteps.push(...result.steps);
    if (result.excerpt) excerpts.push(result.excerpt);
  }

  let excerpt = excerpts.join('\n…\n');
  if (excerpt.length > EXCERPT_BUDGET) {
    excerpt = `…${excerpt.slice(excerpt.length - EXCERPT_BUDGET + 1)}`;
  }

  if (!excerpt.trim()) {
    return buildTriageMessage(
      job,
      `The run failed${failedSteps.length > 0 ? ` (${failedSteps.join(', ')})` : ''}, ` +
        'but I could not retrieve its logs — check the run link above.',
      [],
    );
  }

  const transient = classifyTransient(excerpt);
  if (transient.transient) {
    return buildTransientMessage(job, transient.reason ?? 'infrastructure');
  }

  const errLine =
    topErrorLine(excerpt) ??
    excerpt.split('\n').find((l) => l.trim()) ??
    'unknown error';
  const question =
    `CI failure in ${job.repoFullName}: ${errLine.slice(0, 300)} ` +
    `(workflow ${job.workflowName}${failedSteps[0] ? `, step ${failedSteps[0]}` : ''})`;
  const searchText = [question, ...harvestPaths(excerpt)].join(' ');

  const commitDiffPromise = gh
    .getCommitDiff(repo.owner, repo.name, job.headSha)
    .then((diff) => formatCommitDiff(diff))
    .catch((err) => {
      console.warn('ci triage: commit diff fetch failed', {
        repo: job.repoFullName,
        sha: job.headSha,
        error: (err as Error).message,
      });
      return '';
    });

  const retrievalPromise = retrieveSmart(env, question, searchText, undefined, job.slackTeamId)
    .then((outcome) => ({
      indexedContext: outcome.packed.contextText,
      citations: outcome.packed.citations,
    }))
    .catch((err) => {
      console.warn('ci triage: retrieval failed; triaging from logs only', {
        repo: job.repoFullName,
        error: (err as Error).message,
      });
      return { indexedContext: '', citations: [] as Citation[] };
    });

  const [commitDiff, retrieval] = await Promise.all([
    commitDiffPromise,
    retrievalPromise,
  ]);
  const { indexedContext, citations } = retrieval;

  const analysis = await generateTriage(env, {
    repoFullName: job.repoFullName,
    workflowName: job.workflowName,
    headBranch: job.headBranch,
    runHtmlUrl: job.runHtmlUrl,
    failedSteps,
    logExcerpt: excerpt,
    commitDiff,
    indexedContext,
  });

  return buildTriageMessage(job, analysis, citations);
}

function formatCommitDiff(diff: CommitDiff, maxChars = DIFF_BUDGET): string {
  const parts = [diff.message.split('\n')[0] ?? ''];
  for (const f of diff.files) {
    parts.push(`--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`);
    if (f.patch) parts.push(f.patch);
  }
  const text = parts.join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
