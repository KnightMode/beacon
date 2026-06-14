import { describe, expect, it } from 'vitest';
import { buildIndexDispatchPayload } from './dispatchPayload.js';
import { JOB_TYPES } from '../constants.js';

describe('buildIndexDispatchPayload', () => {
  it('includes installationId for full index jobs', () => {
    expect(
      buildIndexDispatchPayload({
        jobType: JOB_TYPES.FULL_INDEX,
        repoId: 'knightmode/beacon',
        repoFullName: 'KnightMode/beacon',
        installationId: 12345,
        enqueuedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      repo: 'KnightMode/beacon',
      jobType: 'FULL_INDEX',
      commitSha: null,
      installationId: 12345,
      changedFiles: [],
      removedFiles: [],
      force: false,
    });
  });

  it('includes changed and removed files for incremental jobs', () => {
    expect(
      buildIndexDispatchPayload({
        jobType: JOB_TYPES.INCREMENTAL_INDEX,
        repoId: 'knightmode/beacon',
        repoFullName: 'KnightMode/beacon',
        installationId: 99,
        changedFiles: ['src/a.ts'],
        removedFiles: ['src/b.ts'],
        enqueuedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({
      jobType: 'INCREMENTAL_INDEX',
      installationId: 99,
      changedFiles: ['src/a.ts'],
      removedFiles: ['src/b.ts'],
    });
  });
});
