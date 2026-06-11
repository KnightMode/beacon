-- =============================================================================
-- Migration 0002: CI-failure triage tables
-- =============================================================================
-- For deployments whose D1 database was created before CI triage existed in
-- schema.sql. Fresh installs get all of this from schema.sql directly.
--
-- Apply:  wrangler d1 execute scintel --remote --file=packages/shared/migrations/0002_ci_triage.sql
-- (run with --local too if you use a local dev database)
-- =============================================================================

CREATE TABLE IF NOT EXISTS ci_notify_channels (
  repo_id     TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL,
  added_by    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ci_triage_runs (
  run_id      INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  repo_id     TEXT NOT NULL,
  message_ts  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, run_attempt)
);

CREATE INDEX IF NOT EXISTS idx_ci_triage_repo ON ci_triage_runs (repo_id);
