-- Migration 0005: per-tenant CI triage dedupe.
--
-- Legacy ci_triage_runs dedupes globally by (run_id, run_attempt). That is
-- correct for legacy global notifications, but tenant notifications need one
-- claim per Slack workspace when multiple tenants select the same repo.

CREATE TABLE IF NOT EXISTS tenant_ci_triage_runs (
  run_id        INTEGER NOT NULL,
  run_attempt   INTEGER NOT NULL,
  slack_team_id TEXT NOT NULL,
  repo_id       TEXT NOT NULL,
  message_ts    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, run_attempt, slack_team_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_ci_triage_repo
  ON tenant_ci_triage_runs (repo_id, slack_team_id);
