import { describe, it, expect } from 'vitest';
import {
  handleWebhookEvent,
  workflowRunSkipReason,
  type WorkflowRunPayload,
} from '../src/webhook.js';
import type { Env } from '../src/env.js';
import type { TriageJob } from '@scintel/shared';

function workflowRunPayload(
  overrides: Partial<WorkflowRunPayload['workflow_run']> = {},
  repoFullName = 'KnightMode/viper',
): WorkflowRunPayload {
  return {
    action: 'completed',
    workflow_run: {
      id: 1234,
      run_attempt: 2,
      conclusion: 'failure',
      name: 'CI',
      head_branch: 'feature/fix-parser',
      head_sha: 'abc1234def5678',
      html_url: `https://github.com/${repoFullName}/actions/runs/1234`,
      ...overrides,
    },
    repository: { id: 99, full_name: repoFullName },
  };
}

/** Minimal Env stub: allowlist lookup + triage queue capture. */
function stubEnv(opts: { allowlisted: boolean }): {
  env: Env;
  sent: TriageJob[];
} {
  const sent: TriageJob[] = [];
  const env = {
    PIPELINE_DISPATCH_REPO: 'KnightMode/beacon',
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () =>
            opts.allowlisted ? { repo_id: 'knightmode/viper' } : null,
        }),
      }),
    },
    TRIAGE_QUEUE: {
      send: async (job: TriageJob) => {
        sent.push(job);
      },
    },
  } as unknown as Env;
  return { env, sent };
}

describe('workflowRunSkipReason', () => {
  it('skips runs that have not completed', () => {
    const p = workflowRunPayload();
    p.action = 'requested';
    expect(workflowRunSkipReason(p, undefined)).toBe('not-completed');
    p.action = 'in_progress';
    expect(workflowRunSkipReason(p, undefined)).toBe('not-completed');
  });

  it('skips non-failure conclusions', () => {
    for (const conclusion of ['success', 'cancelled', 'skipped', null]) {
      const p = workflowRunPayload({ conclusion });
      expect(workflowRunSkipReason(p, undefined)).toBe('not-failure');
    }
  });

  it('skips the pipeline dispatch repo (case-insensitive)', () => {
    const p = workflowRunPayload({}, 'KnightMode/beacon');
    expect(workflowRunSkipReason(p, 'knightmode/BEACON')).toBe('pipeline-repo');
  });

  it('passes a failure on a PR branch', () => {
    expect(workflowRunSkipReason(workflowRunPayload(), 'KnightMode/beacon')).toBe(
      null,
    );
  });
});

describe('handleWebhookEvent(workflow_run)', () => {
  it('enqueues a TriageJob for an allowlisted repo failure', async () => {
    const { env, sent } = stubEnv({ allowlisted: true });
    const res = await handleWebhookEvent(env, 'workflow_run', workflowRunPayload());
    const body = (await res.json()) as { enqueued?: boolean };
    expect(body.enqueued).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      jobType: 'CI_TRIAGE',
      repoId: 'knightmode/viper',
      repoFullName: 'KnightMode/viper',
      runId: 1234,
      runAttempt: 2,
      workflowName: 'CI',
      headBranch: 'feature/fix-parser',
      headSha: 'abc1234def5678',
      runHtmlUrl: 'https://github.com/KnightMode/viper/actions/runs/1234',
    });
  });

  it('defaults runAttempt to 1 when absent', async () => {
    const { env, sent } = stubEnv({ allowlisted: true });
    const payload = workflowRunPayload({ run_attempt: undefined });
    await handleWebhookEvent(env, 'workflow_run', payload);
    expect(sent[0]?.runAttempt).toBe(1);
  });

  it('does not enqueue for non-allowlisted repos', async () => {
    const { env, sent } = stubEnv({ allowlisted: false });
    const res = await handleWebhookEvent(env, 'workflow_run', workflowRunPayload());
    const body = (await res.json()) as { ignored?: string };
    expect(body.ignored).toBe('not-allowlisted');
    expect(sent).toHaveLength(0);
  });

  it('does not enqueue for successful runs', async () => {
    const { env, sent } = stubEnv({ allowlisted: true });
    const payload = workflowRunPayload({ conclusion: 'success' });
    const res = await handleWebhookEvent(env, 'workflow_run', payload);
    const body = (await res.json()) as { ignored?: string };
    expect(body.ignored).toBe('not-failure');
    expect(sent).toHaveLength(0);
  });
});
