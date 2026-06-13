-- Migration 0004: tenant-scoped onboarding, repo access, and Slack installs.

CREATE TABLE IF NOT EXISTS tenants (
  id                       TEXT PRIMARY KEY,
  name                     TEXT,
  slack_team_id            TEXT NOT NULL UNIQUE,
  status                   TEXT NOT NULL DEFAULT 'ACTIVE',
  resource_set_id          TEXT NOT NULL DEFAULT 'shared',
  onboarding_completed_at  TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slack_user_id   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'ADMIN',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, slack_user_id)
);

CREATE TABLE IF NOT EXISTS tenant_slack_installs (
  tenant_id          TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  slack_team_id      TEXT NOT NULL UNIQUE,
  team_name          TEXT,
  bot_token_enc      TEXT,
  bot_user_id        TEXT,
  installer_user_id  TEXT,
  installed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_github_installations (
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id  INTEGER NOT NULL,
  account_login    TEXT,
  account_type     TEXT,
  installed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, installation_id)
);

CREATE TABLE IF NOT EXISTS pending_installation_repos (
  installation_id  INTEGER NOT NULL,
  repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  full_name        TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (installation_id, repo_id)
);

CREATE TABLE IF NOT EXISTS tenant_repos (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  selected_by  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, repo_id)
);

CREATE TABLE IF NOT EXISTS tenant_onboarding_steps (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  step          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  metadata_json TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, step)
);

CREATE TABLE IF NOT EXISTS tenant_ci_notify_channels (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL,
  added_by    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, repo_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id TEXT,
  event_type    TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  metadata_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_user    ON tenant_members (slack_user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_repos_repo      ON tenant_repos (repo_id);
CREATE INDEX IF NOT EXISTS idx_tenant_repos_enabled   ON tenant_repos (tenant_id, enabled);
CREATE INDEX IF NOT EXISTS idx_tenant_github_install  ON tenant_github_installations (installation_id);
CREATE INDEX IF NOT EXISTS idx_pending_install_repos  ON pending_installation_repos (installation_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant    ON audit_events (tenant_id, created_at);
