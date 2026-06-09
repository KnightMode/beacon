/**
 * Manual indexing CLI.
 *
 *   npm run index -- <owner/repo>                         # FULL_INDEX
 *   npm run index -- <owner/repo> --commit <sha>          # FULL_INDEX at sha
 *   npm run index -- <owner/repo> --incremental a.go b.ts # INCREMENTAL_INDEX
 *   npm run index -- --help
 *
 * `--help` works without any environment configuration.
 */

import { JOB_TYPES, type IndexJob } from '@scintel/shared';
import { repoIdFor } from './core/store.js';

const HELP = `scintel indexer CLI

Usage:
  npm run index -- <owner/repo>                          Run a FULL_INDEX
  npm run index -- <owner/repo> --commit <sha>           FULL_INDEX at a commit
  npm run index -- <owner/repo> --incremental <files...> INCREMENTAL re-index
  npm run index -- --help                                Show this help

Environment (see .env.example): GITHUB_PAT, CLOUDFLARE_ACCOUNT_ID,
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
  const incrementalFiles: string[] = [];
  let mode: 'full' | 'incremental' = 'full';

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--commit') {
      commitSha = argv[++i];
    } else if (arg === '--incremental') {
      mode = 'incremental';
    } else if (mode === 'incremental') {
      incrementalFiles.push(arg);
    }
  }

  // Defer config + heavy imports until we actually need to index, so that
  // --help never touches the environment or loads wasm.
  const { loadConfig } = await import('./config.js');
  const { indexRepo } = await import('./core/indexRepo.js');
  const config = loadConfig();

  const repoId = repoIdFor(repoFullName);
  const job: IndexJob =
    mode === 'incremental'
      ? {
          jobType: JOB_TYPES.INCREMENTAL_INDEX,
          repoId,
          repoFullName,
          commitSha,
          changedFiles: incrementalFiles,
          removedFiles: [],
          enqueuedAt: new Date().toISOString(),
        }
      : {
          jobType: JOB_TYPES.FULL_INDEX,
          repoId,
          repoFullName,
          commitSha,
          enqueuedAt: new Date().toISOString(),
        };

  process.stdout.write(`Indexing ${repoFullName} (${job.jobType})...\n`);
  const result = await indexRepo(config, job);
  process.stdout.write(`Done: ${JSON.stringify(result, null, 2)}\n`);
}

run().catch((err) => {
  process.stderr.write(`indexer failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
