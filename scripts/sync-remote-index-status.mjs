#!/usr/bin/env node
/**
 * Copy repo_index_status from remote Cloudflare D1 into local D1.
 * Use when local portal shows stale PENDING but GitHub Actions finished on remote D1.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function wranglerD1(command, remote) {
  const args = [
    'wrangler', 'd1', 'execute', 'scintel',
    remote ? '--remote' : '--local',
    ...(remote ? [] : ['--persist-to', '.wrangler/state']),
    '--command', command,
    '--json',
  ];
  const out = execFileSync('npx', args, { cwd: root, encoding: 'utf8' });
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? [];
}

const localRepos = wranglerD1(
  `SELECT tr.repo_id
   FROM tenant_repos tr
   WHERE tr.enabled = 1`,
  false,
);
if (localRepos.length === 0) {
  console.log('No tenant repos in local D1.');
  process.exit(0);
}

const repoIds = [...new Set(localRepos.map((row) => row.repo_id))]
  .map((repoId) => `'${repoId.replace(/'/g, "''")}'`)
  .join(', ');
const remoteRows = wranglerD1(
  `SELECT repo_id, status, indexed_files, total_files, total_chunks, error
   FROM repo_index_status
   WHERE repo_id IN (${repoIds})`,
  true,
);

if (remoteRows.length === 0) {
  console.log('No matching repo_index_status rows on remote D1.');
  process.exit(0);
}

for (const row of remoteRows) {
  const sql = `INSERT INTO repo_index_status
    (repo_id, status, job_type, total_files, indexed_files, total_chunks, error, updated_at)
    VALUES (
      '${row.repo_id.replace(/'/g, "''")}',
      '${row.status.replace(/'/g, "''")}',
      'FULL_INDEX',
      ${row.total_files ?? 'NULL'},
      ${row.indexed_files ?? 'NULL'},
      ${row.total_chunks ?? 'NULL'},
      ${row.error ? `'${String(row.error).replace(/'/g, "''")}'` : 'NULL'},
      datetime('now')
    )
    ON CONFLICT(repo_id) DO UPDATE SET
      status = excluded.status,
      total_files = COALESCE(excluded.total_files, repo_index_status.total_files),
      indexed_files = COALESCE(excluded.indexed_files, repo_index_status.indexed_files),
      total_chunks = COALESCE(excluded.total_chunks, repo_index_status.total_chunks),
      error = excluded.error,
      updated_at = datetime('now')`;
  wranglerD1(sql, false);
  console.log(`✓ ${row.repo_id} → ${row.status} (${row.indexed_files ?? 0}/${row.total_files ?? '?'})`);
}

console.log(`\nSynced ${remoteRows.length} repo status row(s) into local D1.`);
