/**
 * CI entrypoint for the indexer pipeline (.github/workflows/index.yml).
 *
 * Reads the index request from environment variables populated either by a
 * repository_dispatch client_payload (PAYLOAD_*) or by a manual
 * workflow_dispatch input (INPUT_*), validates them, and invokes the indexer
 * CLI with a safely-constructed argv array (no shell string concatenation).
 */

import { spawnSync } from 'node:child_process';

const REPO_RE = /^[A-Za-z0-9._\/-]+\/[A-Za-z0-9._-]+$/;

function fail(message) {
  process.stderr.write(`ci-index: ${message}\n`);
  process.exit(1);
}

const repo = (process.env.PAYLOAD_REPO || process.env.INPUT_REPO || '').trim();
if (!REPO_RE.test(repo)) {
  fail(`invalid or missing repo "${repo}" (expected owner/repo)`);
}

const jobType = (
  process.env.PAYLOAD_JOBTYPE ||
  process.env.INPUT_JOBTYPE ||
  'FULL_INDEX'
).trim();

const sha = (process.env.PAYLOAD_SHA || process.env.INPUT_SHA || '').trim();

let files = [];
if (process.env.PAYLOAD_FILES_JSON && process.env.PAYLOAD_FILES_JSON.trim() !== '') {
  try {
    const parsed = JSON.parse(process.env.PAYLOAD_FILES_JSON);
    if (Array.isArray(parsed)) files = parsed;
  } catch {
    files = [];
  }
} else if (process.env.INPUT_FILES && process.env.INPUT_FILES.trim() !== '') {
  files = process.env.INPUT_FILES.split(/\s+/);
}
files = files.filter((f) => typeof f === 'string' && f.trim() !== '').map((f) => f.trim());

const args = ['tsx', 'src/cli.ts', repo];
if (jobType === 'INCREMENTAL_INDEX' && files.length) {
  args.push('--incremental', ...files);
}
if (sha) {
  args.push('--commit', sha);
}

process.stdout.write(
  `ci-index: repo=${repo} jobType=${jobType} files=${files.length}` +
    (sha ? ` commit=${sha}` : '') +
    '\n',
);

const child = spawnSync('npx', args, {
  stdio: 'inherit',
  cwd: process.cwd(),
  shell: false,
});

process.exit(child.status ?? 1);
