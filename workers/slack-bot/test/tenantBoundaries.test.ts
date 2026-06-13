import { describe, it, expect, vi } from 'vitest';
import { indexRepoAction, indexStatusAction } from '../src/actions/indexRepo.js';
import { resolveTargetRepo } from '../src/repoTarget.js';

describe('Slack tenant boundaries', () => {
  it('does not resolve PR targets for unknown Slack teams', async () => {
    const env = {
      DEFAULT_PR_REPO: 'KnightMode/beacon',
      DB: {
        prepare(sql: string) {
          if (sql.includes('FROM tenants')) {
            return {
              bind: () => ({ first: async () => null }),
            };
          }
          throw new Error(`unexpected fallback query: ${sql}`);
        },
      },
    };

    await expect(
      resolveTargetRepo(env as never, 'create a PR in KnightMode/beacon', 'T_UNKNOWN'),
    ).resolves.toBeNull();
  });

  it('does not expose global index status to unknown Slack teams', async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          if (sql.includes('FROM tenants')) {
            return {
              bind: () => ({ first: async () => null }),
            };
          }
          throw new Error(`global status query should not run: ${sql}`);
        },
      },
    };

    await expect(indexStatusAction(env as never, 'T_UNKNOWN')).resolves.toContain(
      'not onboarded yet',
    );
  });

  it('rejects Slack index requests for repos outside the tenant GitHub installation', async () => {
    const queries: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 12345,
          full_name: 'Other/private',
          default_branch: 'main',
          private: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const env = {
      GITHUB_PAT: 'github_pat_test',
      INDEX_DISPATCH_REPO: 'KnightMode/beacon',
      DB: {
        prepare(sql: string) {
          queries.push(sql);
          if (sql.includes('FROM tenants')) {
            return {
              bind: () => ({ first: async () => ({ id: 'tenant_1' }) }),
            };
          }
          if (sql.includes('FROM tenant_github_installations')) {
            return {
              bind: () => ({ first: async () => null }),
            };
          }
          throw new Error(`unauthorized repo should not be written: ${sql}`);
        },
      },
    };

    try {
      await expect(
        indexRepoAction(env as never, 'Other/private', 'T_ALLOWED'),
      ).resolves.toContain('not available on this workspace');
    } finally {
      fetchMock.mockRestore();
    }
    expect(queries.some((sql) => sql.includes('INSERT INTO repos'))).toBe(false);
    expect(queries.some((sql) => sql.includes('INSERT INTO tenant_repos'))).toBe(false);
  });
});
