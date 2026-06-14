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
function stubEnv(opts: { allowlisted: boolean; slackTeamIds?: string[] }): {
  env: Env;
  sent: TriageJob[];
} {
  const sent: TriageJob[] = [];
  const env = {
    PIPELINE_DISPATCH_REPO: 'KnightMode/beacon',
    DB: {
      prepare: (_sql: string) => ({
        bind: () => ({
          first: async () =>
            opts.allowlisted ? { repo_id: 'knightmode/viper' } : null,
          all: async () => ({
            results: (opts.slackTeamIds ?? []).map((slack_team_id) => ({
              slack_team_id,
            })),
          }),
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

  it('enqueues one triage job per mapped tenant for shared repos', async () => {
    const { env, sent } = stubEnv({
      allowlisted: true,
      slackTeamIds: ['T_ALPHA', 'T_BRAVO'],
    });
    const res = await handleWebhookEvent(env, 'workflow_run', workflowRunPayload());
    const body = (await res.json()) as { enqueued?: boolean };
    expect(body.enqueued).toBe(true);
    expect(sent.map((job) => job.slackTeamId)).toEqual(['T_ALPHA', 'T_BRAVO']);
    expect(sent.every((job) => job.runId === 1234 && job.runAttempt === 2)).toBe(true);
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

describe('handleWebhookEvent(installation_repositories)', () => {
  /** Records every prepared statement (run/first/all/batch) for assertions. */
  function installationEnv(opts: { inUse: boolean; chunkIds?: string[] }): {
    env: Env;
    batched: Array<{ sql: string; args: unknown[] }>;
    runs: Array<{ sql: string; args: unknown[] }>;
    deletedVectors: string[][];
  } {
    const batched: Array<{ sql: string; args: unknown[] }> = [];
    const runs: Array<{ sql: string; args: unknown[] }> = [];
    const deletedVectors: string[][] = [];
    const env = {
      VECTORIZE: {
        deleteByIds: async (ids: string[]) => {
          deletedVectors.push(ids);
        },
      },
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            sql,
            args,
            run: async () => {
              runs.push({ sql, args });
              return undefined;
            },
            first: async () => (opts.inUse ? { x: 1 } : null),
            all: async () => ({
              results: (opts.chunkIds ?? []).map((id) => ({ id })),
            }),
          }),
        }),
        batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
          batched.push(...statements);
          return [];
        },
      },
    } as unknown as Env;
    return { env, batched, runs, deletedVectors };
  }

  it('revokes grants and purges the index when an orphaned repo is removed', async () => {
    const { env, batched, runs, deletedVectors } = installationEnv({
      inUse: false,
      chunkIds: ['c1', 'c2'],
    });

    const res = await handleWebhookEvent(env, 'installation_repositories', {
      action: 'removed',
      installation: { id: 98765 },
      repositories_removed: [{ full_name: 'KnightMode/viper' }],
    });
    const body = (await res.json()) as {
      revoked?: string[];
      purged?: string[];
      enqueued?: string[];
    };

    expect(body.revoked).toEqual(['KnightMode/viper']);
    expect(body.purged).toEqual(['KnightMode/viper']);
    expect(body.enqueued).toEqual([]);

    const sqls = batched.map((s) => s.sql);
    expect(sqls.some((s) => s.includes('UPDATE tenant_repos'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM chunks WHERE repo_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM repos WHERE id'))).toBe(true);
    expect(runs.some((r) => r.sql.includes('UPDATE prototype_repo_allowlist'))).toBe(true);
    expect(deletedVectors).toEqual([['c1', 'c2']]);
  });

  it('does not purge a repo that is still in use by another tenant', async () => {
    const { env, batched, deletedVectors } = installationEnv({ inUse: true });

    const res = await handleWebhookEvent(env, 'installation_repositories', {
      action: 'removed',
      installation: { id: 98765 },
      repositories_removed: [{ full_name: 'KnightMode/viper' }],
    });
    const body = (await res.json()) as { revoked?: string[]; purged?: string[] };

    expect(body.revoked).toEqual(['KnightMode/viper']);
    expect(body.purged).toEqual([]);
    expect(deletedVectors).toEqual([]);
    expect(batched.some((s) => s.sql.includes('DELETE FROM repos WHERE id'))).toBe(false);
  });
});
