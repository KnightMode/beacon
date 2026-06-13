import { describe, expect, it } from 'vitest';
import { resolveTenantInstallationRepo } from './repos.js';

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

function repoValidationEnv({ installationId, localGrant }) {
  return {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              first: async () => {
                if (sql.includes('FROM tenant_github_installations')) {
                  return { installation_id: installationId };
                }
                if (sql.includes('FROM pending_installation_repos')) {
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
