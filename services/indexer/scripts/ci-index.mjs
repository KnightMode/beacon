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

function fileList(payloadJson, inputText) {
  let files = [];
  // repository_dispatch path: a JSON array. For workflow_dispatch this field is
  // toJSON(undefined|null) === "null" (a non-empty string), so treat "null"/""
  // /non-arrays as absent and fall back to the workflow_dispatch input text.
  const pj = (payloadJson || '').trim();
  if (pj !== '' && pj !== 'null') {
    try {
      const parsed = JSON.parse(pj);
      if (Array.isArray(parsed)) files = parsed;
    } catch {
      files = [];
    }
  }
  if (files.length === 0 && inputText && inputText.trim() !== '') {
    files = inputText.split(/\s+/);
  }
  return files
    .filter((f) => typeof f === 'string' && f.trim() !== '')
    .map((f) => f.trim());
}

const files = fileList(process.env.PAYLOAD_FILES_JSON, process.env.INPUT_FILES);
const removed = fileList(process.env.PAYLOAD_REMOVED_JSON, process.env.INPUT_REMOVED);

const force =
  (process.env.PAYLOAD_FORCE || process.env.INPUT_FORCE || '')
    .trim()
    .toLowerCase() === 'true';

const args = ['tsx', 'src/cli.ts', repo];
if (jobType === 'INCREMENTAL_INDEX' && (files.length || removed.length)) {
  args.push('--incremental', ...files);
  if (removed.length) args.push('--removed', ...removed);
} else if (force) {
  args.push('--force');
}
if (sha) {
  args.push('--commit', sha);
}

process.stdout.write(
  `ci-index: repo=${repo} jobType=${jobType} files=${files.length} removed=${removed.length}` +
    (sha ? ` commit=${sha}` : '') +
    '\n',
);

const child = spawnSync('npx', args, {
  stdio: 'inherit',
  cwd: process.cwd(),
  shell: false,
});

process.exit(child.status ?? 1);
