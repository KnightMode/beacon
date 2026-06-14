-- Migration 0006: live GitHub installation repo grants and selected installation routing.
--
-- This is intentionally a one-time migration for deployed databases that were
-- created before `tenant_repos.installation_id` existed. Fresh local databases
-- get the same shape directly from `schema.sql`.

CREATE TABLE IF NOT EXISTS github_installation_repos (
  installation_id  INTEGER NOT NULL,
  repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  full_name        TEXT NOT NULL,
  github_id        INTEGER,
  default_branch   TEXT NOT NULL DEFAULT 'main',
  private          INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (installation_id, repo_id)
);

INSERT INTO github_installation_repos
  (installation_id, repo_id, full_name, updated_at)
SELECT installation_id, repo_id, full_name, datetime('now')
FROM pending_installation_repos
WHERE true
ON CONFLICT(installation_id, repo_id) DO UPDATE SET
  full_name = excluded.full_name,
  updated_at = datetime('now');

ALTER TABLE tenant_repos ADD COLUMN installation_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_github_install_repos ON github_installation_repos (repo_id);
