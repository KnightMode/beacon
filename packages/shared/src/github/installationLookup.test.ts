import { describe, expect, it } from 'vitest';
import { lookupInstallationIdForRepo } from './installationLookup.js';

describe('lookupInstallationIdForRepo', () => {
  it('prefers pending installation repos before tenant joins', async () => {
    const calls: string[] = [];
    const db = {
      prepare(sql: string) {
        calls.push(sql);
        return {
          bind(...args: unknown[]) {
            const repoId = args[0];
            return {
              async first<T>() {
                if (sql.includes('pending_installation_repos') && repoId === 'knightmode/agent-session') {
                  return { installation_id: 777 } as T;
                }
                return null;
              },
            };
          },
        };
      },
    };

    await expect(lookupInstallationIdForRepo(db, 'KnightMode/agent-session')).resolves.toBe(777);
    expect(calls.some((sql) => sql.includes('pending_installation_repos'))).toBe(true);
  });
});
