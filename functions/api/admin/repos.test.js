import { describe, expect, it } from 'vitest';
import { markRepoIndexRequested, resolveTenantInstallationRepo } from './repos.js';

describe('resolveTenantInstallationRepo', () => {
  it('accepts repos already granted by the tenant GitHub installation', async () => {
    const env = repoValidationEnv({
      installationId: 12345,
      localGrant: {
        full_name: 'KnightMode/beacon',
        github_id: 42,
        default_branch: 'main',
        private: 1,
      },
    });

    await expect(resolveTenantInstallationRepo(env, 'T_BEACON', 'KnightMode/beacon')).resolves.toEqual({
      fullName: 'KnightMode/beacon',
      installationId: 12345,
      githubId: 42,
      defaultBranch: 'main',
      private: true,
    });
  });

  it('rejects arbitrary repos that are not on the linked installation', async () => {
    const env = repoValidationEnv({ installationId: 12345, localGrant: null });

    await expect(
      resolveTenantInstallationRepo(env, 'T_BEACON', 'OtherOrg/private-repo'),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('markRepoIndexRequested', () => {
  it('does not downgrade an already-ready repo status to pending', async () => {
    const prepared = [];
    const env = {
      DB: {
        prepare(sql) {
          prepared.push({ sql, args: [] });
          return {
            bind(...args) {
              prepared[prepared.length - 1].args = args;
              return { run: async () => ({}) };
            },
          };
        },
      },
    };

    await markRepoIndexRequested(env, 'knightmode/designpatterns');

    expect(prepared).toHaveLength(1);
    expect(prepared[0].args).toEqual(['knightmode/designpatterns']);
    expect(prepared[0].sql).toContain("repo_index_status.status = 'READY'");
    expect(prepared[0].sql).toContain("indexing_status FROM repos WHERE id = ?1) = 'READY'");
  });
});

function repoValidationEnv({ installationId, localGrant }) {
  return {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              all: async () => {
                if (sql.includes('FROM tenant_github_installations')) {
                  return { results: [{ installation_id: installationId }] };
                }
                return { results: [] };
              },
              first: async () => {
                if (sql.includes('FROM github_installation_repos')) {
                  return localGrant;
                }
                return null;
              },
            };
          },
        };
      },
    },
  };
}
