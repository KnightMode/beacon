#!/usr/bin/env node
/**
 * Apply admin/control-plane D1 migrations in a deploy-safe way.
 *
 * Migration 0006 adds a column, which cannot be blindly re-run on SQLite/D1.
 * This runner keeps the existing SQL migrations for table/index creation and
 * guards one-time ALTER statements with schema inspection.
 */

import { spawnSync } from 'node:child_process';

const dbName =
  process.argv[2]
  || process.env.PAGES_D1_DATABASE_NAME
  || process.env.D1_DATABASE_NAME
  || 'scintel';
const local = process.env.D1_LOCAL === '1';
const persistTo = process.env.D1_PERSIST_TO || '.wrangler/state';

function main() {
  console.log(`Applying admin D1 migrations to ${dbName} (${local ? 'local' : 'remote'})...`);
  runFile('packages/shared/migrations/0004_tenants.sql');
  runFile('packages/shared/migrations/0005_tenant_ci_triage_runs.sql');
  applyInstallationGrantMigration();
  runFile('packages/shared/migrations/0007_code_intel_foundation.sql');
  applyGitBlobShaMigration();
  // 0008_git_blob_sha.sql is comment-only (the ALTER is guarded above) and
  // wrangler errors on SQL files without statements, so it is not runFile'd.
  runFile('packages/shared/migrations/0009_tenant_admin_emails.sql');
  console.log('Admin D1 migrations applied.');
}

function applyGitBlobShaMigration() {
  if (!columnExists('files', 'git_blob_sha')) {
    runSql('ALTER TABLE files ADD COLUMN git_blob_sha TEXT');
  } else {
    console.log('files.git_blob_sha already exists; skipping ALTER TABLE.');
  }
}

function applyInstallationGrantMigration() {
  runSql(`
CREATE TABLE IF NOT EXISTS github_installation_repos (
  installation_id  INTEGER NOT NULL,
  repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  full_name        TEXT NOT NULL,
  github_id        INTEGER,
  default_branch   TEXT NOT NULL DEFAULT 'main',
  private          INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (installation_id, repo_id)
)`);

  if (!columnExists('tenant_repos', 'installation_id')) {
    runSql('ALTER TABLE tenant_repos ADD COLUMN installation_id INTEGER');
  } else {
    console.log('tenant_repos.installation_id already exists; skipping ALTER TABLE.');
  }

  runSql(`
INSERT INTO github_installation_repos
  (installation_id, repo_id, full_name, updated_at)
SELECT installation_id, repo_id, full_name, datetime('now')
FROM pending_installation_repos
WHERE true
ON CONFLICT(installation_id, repo_id) DO UPDATE SET
  full_name = excluded.full_name,
  updated_at = datetime('now')`);

  runSql(
    'CREATE INDEX IF NOT EXISTS idx_github_install_repos ON github_installation_repos (repo_id)',
  );
}

function columnExists(tableName, columnName) {
  const rows = queryJson(
    `SELECT name FROM pragma_table_info('${escapeSqlIdentifier(tableName)}') ` +
      `WHERE name = '${escapeSqlIdentifier(columnName)}'`,
  );
  return rows.some((row) => row.name === columnName);
}

function runFile(file) {
  runWrangler(['--file', file]);
}

function runSql(sql) {
  runWrangler(['--command', sql.trim()]);
}

function queryJson(sql) {
  const stdout = runWrangler(['--command', sql.trim(), '--json'], { capture: true });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed[0]?.success !== true) {
    throw new Error(`Unexpected wrangler JSON response: ${stdout}`);
  }
  return parsed[0].results || [];
}

function runWrangler(extraArgs, options = {}) {
  const args = ['wrangler', 'd1', 'execute', dbName, local ? '--local' : '--remote'];
  if (local) args.push('--persist-to', persistTo);
  args.push(...extraArgs);

  const result = spawnSync('npx', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed with exit code ${result.status}`);
  }
  return result.stdout || '';
}

function escapeSqlIdentifier(value) {
  return String(value).replace(/'/g, "''");
}

main();
