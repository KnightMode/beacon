/**
 * Resolve the GitHub token used to read repository contents during indexing.
 */

import { createInstallationAccessToken, type GitHubAppCredentials } from '@scintel/shared';
import type { IndexerConfig } from './config.js';
import type { IndexJob } from '@scintel/shared';

export async function resolveGithubAccessToken(
  config: IndexerConfig,
  job?: IndexJob,
): Promise<string> {
  const preMinted = config.github.installationToken?.trim();
  if (preMinted) return preMinted;

  const installationId = job?.installationId ?? config.github.installationId;
  const appId = config.github.appId?.trim();
  const privateKey = config.github.appPrivateKey?.trim();
  if (installationId && appId && privateKey) {
    return createInstallationAccessToken(
      { appId, privateKey } satisfies GitHubAppCredentials,
      installationId,
    );
  }

  const pat = config.github.pat?.trim();
  if (pat) return pat;

  throw new Error(
    'GitHub credentials missing for indexing. Provide GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY ' +
      'with installationId in the index job, or set GITHUB_PAT for legacy indexing.',
  );
}
