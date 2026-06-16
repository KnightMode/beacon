/**
 * Manual indexing CLI.
 *
 *   npm run index -- <owner/repo>                         # FULL_INDEX
 *   npm run index -- <owner/repo> --commit <sha>          # FULL_INDEX at sha
 *   npm run index -- <owner/repo> --incremental a.go b.ts # INCREMENTAL_INDEX
 *   npm run index -- <owner/repo> --incremental a.go --removed b.ts
 *   npm run index -- <owner/repo> --installation-id 123   # GitHub App auth
 *   npm run index -- <owner/repo> --result-json /tmp/result.json
 *   npm run index -- --help
 *
 * `--help` works without any environment configuration.
 */

import { JOB_TYPES, type IndexJob } from '@scintel/shared';
import { repoIdFor } from './core/store.js';

const HELP = `scintel indexer CLI

Usage:
  npm run index -- <owner/repo>                          Run a FULL_INDEX
  npm run index -- <owner/repo> --force                  Full re-chunk/re-embed
                                                         (skips no shortcuts)
  npm run index -- <owner/repo> --commit <sha>           FULL_INDEX at a commit
  npm run index -- <owner/repo> --installation-id <id>    Use GitHub App auth
  npm run index -- <owner/repo> --tenant-id <id>          Tag tenant vectors
  npm run index -- <owner/repo> --result-json <path>      Write machine-readable result JSON
  npm run index -- <owner/repo> --incremental <files...> INCREMENTAL re-index
  npm run index -- <owner/repo> --incremental <files...> --removed <files...>
                                                         also delete removed files
  npm run index -- --help                                Show this help

Environment (see .env.example): GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
(tenant jobs) or GITHUB_PAT (legacy local jobs), CLOUDFLARE_ACCOUNT_ID,
CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_VECTORIZE_INDEX,
INDEXER_SHARED_SECRET, EMBEDDING_MODEL, LLM_MODEL.
`;

async function run(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const repoFullName = argv[0]!;
  if (!repoFullName.includes('/')) {
    process.stderr.write(`error: expected <owner/repo>, got "${repoFullName}"\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  let commitSha: string | undefined;
  let tenantId: string | undefined;
  let installationId: number | undefined;
  let resultJsonPath: string | undefined;
  let force = false;
  const incrementalFiles: string[] = [];
  const removedFiles: string[] = [];
  let mode: 'full' | 'incremental' | 'removed' = 'full';

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--commit') {
      commitSha = requiredArgValue(argv, ++i, '--commit');
    } else if (arg === '--tenant-id') {
      tenantId = requiredArgValue(argv, ++i, '--tenant-id');
    } else if (arg === '--installation-id') {
      const raw = requiredArgValue(argv, ++i, '--installation-id');
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        process.stderr.write(`error: --installation-id must be a positive integer, got "${raw}"\n`);
        process.exitCode = 1;
        return;
      }
      installationId = parsed;
    } else if (arg === '--result-json') {
      resultJsonPath = requiredArgValue(argv, ++i, '--result-json');
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--incremental') {
      mode = 'incremental';
    } else if (arg === '--removed') {
      mode = 'removed';
    } else if (mode === 'incremental') {
      incrementalFiles.push(arg);
    } else if (mode === 'removed') {
      removedFiles.push(arg);
    }
  }

  // Defer config + heavy imports until we actually need to index, so that
  // --help never touches the environment or loads wasm.
  const { loadConfig } = await import('./config.js');
  const { indexRepo } = await import('./core/indexRepo.js');
  const config = loadConfig();

  const repoId = repoIdFor(repoFullName);
  const commonJob = {
    repoId,
    repoFullName,
    commitSha,
    tenantId,
    installationId,
    enqueuedAt: new Date().toISOString(),
  };
  const job: IndexJob =
    mode !== 'full'
      ? {
          ...commonJob,
          jobType: JOB_TYPES.INCREMENTAL_INDEX,
          changedFiles: incrementalFiles,
          removedFiles,
        }
      : {
          ...commonJob,
          jobType: JOB_TYPES.FULL_INDEX,
          force,
        };

  process.stdout.write(
    `Indexing ${repoFullName} (${job.jobType})` +
      (tenantId ? ` tenant=${tenantId}` : '') +
      (installationId ? ` installation=${installationId}` : '') +
      '...\n',
  );
  const result = await indexRepo(config, job);
  if (resultJsonPath) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(resultJsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`Done: ${JSON.stringify(result, null, 2)}\n`);
}

function requiredArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

run().catch((err) => {
  process.stderr.write(`indexer failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
