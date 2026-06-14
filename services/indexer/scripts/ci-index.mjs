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
const D1_API = 'https://api.cloudflare.com/client/v4';

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

const installationId = await resolveInstallationId(repo);

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
  `ci-index: repo=${repo} jobType=${jobType} installationId=${installationId}` +
    ` files=${files.length} removed=${removed.length}` +
    (sha ? ` commit=${sha}` : '') +
    '\n',
);

const childEnv = {
  ...process.env,
  GITHUB_APP_INSTALLATION_ID: String(installationId),
};

const child = spawnSync('npx', args, {
  stdio: 'inherit',
  cwd: process.cwd(),
  shell: false,
  env: childEnv,
});

process.exit(child.status ?? 1);

function parseInstallationId(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === 'null') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

async function resolveInstallationId(repoFullName) {
  const fromPayload = parseInstallationId(process.env.PAYLOAD_INSTALLATION_ID);
  if (fromPayload) return fromPayload;

  const fromInput = parseInstallationId(process.env.INPUT_INSTALLATION_ID);
  if (fromInput) return fromInput;

  const fromEnv = parseInstallationId(process.env.GITHUB_APP_INSTALLATION_ID);
  if (fromEnv) return fromEnv;

  const lookedUp = await lookupInstallationIdFromD1(repoFullName.toLowerCase());
  if (lookedUp) return lookedUp;

  fail(
    `missing installationId for ${repoFullName}. Connect the repo via the GitHub App ` +
      'and include installationId in the index dispatch payload.',
  );
}

async function lookupInstallationIdFromD1(repoId) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
  if (!accountId || !apiToken || !databaseId) return null;

  const pending = await d1Query(accountId, apiToken, databaseId, {
    sql: `SELECT installation_id
          FROM pending_installation_repos
          WHERE repo_id = ?1
          LIMIT 1`,
    params: [repoId],
  });
  if (pending[0]?.installation_id) return Number(pending[0].installation_id);

  const tenantLinked = await d1Query(accountId, apiToken, databaseId, {
    sql: `SELECT gi.installation_id
          FROM tenant_github_installations gi
          JOIN tenant_repos tr ON tr.tenant_id = gi.tenant_id
          WHERE tr.repo_id = ?1 AND tr.enabled = 1
          ORDER BY gi.updated_at DESC
          LIMIT 1`,
    params: [repoId],
  });
  if (tenantLinked[0]?.installation_id) return Number(tenantLinked[0].installation_id);

  return null;
}

async function d1Query(accountId, apiToken, databaseId, { sql, params }) {
  const res = await fetch(
    `${D1_API}/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  if (!res.ok) return [];
  const body = await res.json();
  if (!body.success) return [];
  return body.result?.[0]?.results ?? [];
}
