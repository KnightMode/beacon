import type { IndexJob } from '../types.js';

/** client_payload shape for repository_dispatch index-repo events. */
export function buildIndexDispatchPayload(job: IndexJob): Record<string, unknown> {
  const base = {
    repo: job.repoFullName,
    jobType: job.jobType,
    commitSha: job.commitSha ?? null,
    installationId: job.installationId ?? null,
  };

  if (job.jobType === 'INCREMENTAL_INDEX') {
    return {
      ...base,
      changedFiles: job.changedFiles,
      removedFiles: job.removedFiles,
      force: false,
    };
  }

  return {
    ...base,
    changedFiles: [],
    removedFiles: [],
    force: job.force ?? false,
  };
}
