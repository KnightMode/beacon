-- =============================================================================
-- Slack Code Intelligence Bot — Cloudflare D1 schema
-- =============================================================================
-- Apply locally:   wrangler d1 execute <DB_NAME> --local  --file=packages/shared/schema.sql
-- Apply remote:    wrangler d1 execute <DB_NAME> --remote --file=packages/shared/schema.sql
--
-- Notes:
--  * D1 is SQLite. Timestamps are stored as ISO-8601 TEXT (UTC).
--  * Booleans are stored as INTEGER (0/1).
--  * `users` and `github_user_repo_permissions` are NOT used by the prototype
--    auth model (single PAT + static allowlist). They exist as clean extension
--    points for production per-user GitHub OAuth + permission sync.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---- Repositories -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS repos (
  id              TEXT PRIMARY KEY,                 -- internal id (e.g. "<owner>/<name>")
  github_id       INTEGER,                          -- GitHub numeric repo id (nullable for PAT-only)
  full_name       TEXT NOT NULL UNIQUE,             -- "owner/name"
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  private         INTEGER NOT NULL DEFAULT 1,       -- boolean
  indexing_status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|INDEXING|READY|FAILED
  last_indexed_sha TEXT,
  last_indexed_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Files (per indexed commit) ---------------------------------------------
CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,                    -- "<repo_id>:<path>"
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  language     TEXT,                                -- detected language (e.g. "go", "typescript")
  size_bytes   INTEGER,
  content_hash TEXT,                                -- sha-256 of file contents
  commit_sha   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, path)
);

-- ---- Semantic code / doc chunks ---------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,                    -- stable hash id (also the Vectorize vector id)
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  language     TEXT,
  chunk_type   TEXT NOT NULL,                       -- function|method|class|struct|type|interface|import|call|markdown_section|generic
  symbol       TEXT,                                -- symbol name when applicable
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  content      TEXT NOT NULL,                       -- raw chunk source (may be redacted)
  content_hash TEXT NOT NULL,
  commit_sha   TEXT,
  embedded     INTEGER NOT NULL DEFAULT 0,          -- boolean: vector upserted to Vectorize
  redacted     INTEGER NOT NULL DEFAULT 0,          -- boolean: secrets were redacted
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Full-text search over chunks (FTS5, external content) ------------------
-- BM25-ranked lexical search. The index stores no copy of the content; it
-- references `chunks` by rowid. Triggers keep it in sync with every chunk
-- insert/update/delete, so the indexer needs no FTS-specific code.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  symbol,
  path,
  content,
  content='chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, symbol, path, content)
  VALUES (new.rowid, new.symbol, new.path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, symbol, path, content)
  VALUES ('delete', old.rowid, old.symbol, old.path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, symbol, path, content)
  VALUES ('delete', old.rowid, old.symbol, old.path, old.content);
  INSERT INTO chunks_fts (rowid, symbol, path, content)
  VALUES (new.rowid, new.symbol, new.path, new.content);
END;

-- (Re)build the FTS index from the chunks table. 'rebuild' is the canonical,
-- idempotent way to populate an external-content FTS5 table — do NOT use a
-- self-referencing INSERT...SELECT here; that corrupts the vtab on D1
-- (SQLITE_CORRUPT_VTAB).
INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild');

-- ---- Graph edges (IMPORTS / CALLS) ------------------------------------------
CREATE TABLE IF NOT EXISTS code_edges (
  id           TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  edge_type    TEXT NOT NULL,                       -- IMPORTS|CALLS
  from_node_id TEXT NOT NULL,                       -- chunk id or symbol node id
  to_node_id   TEXT NOT NULL,                       -- chunk id, symbol, or import target
  from_symbol  TEXT,
  to_symbol    TEXT,
  file_id      TEXT REFERENCES files(id) ON DELETE CASCADE,
  start_line   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- External code-intelligence artifacts (Zoekt / SCIP) -------------------
-- Heavy index generation runs outside Workers (currently GitHub Actions). These
-- rows are the control-plane manifest for the artifacts produced for a repo
-- commit: Zoekt shards in R2 / container-local disk, raw SCIP indexes, and the
-- normalized facts ingested from SCIP.
CREATE TABLE IF NOT EXISTS code_index_artifacts (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,                      -- ZOEKT_SHARD|SCIP_INDEX|SCIP_SYMBOLS
  status        TEXT NOT NULL DEFAULT 'PENDING',    -- PENDING|READY|FAILED|DISABLED
  commit_sha    TEXT NOT NULL,
  language      TEXT NOT NULL DEFAULT '',
  producer      TEXT NOT NULL,                      -- tool/version, e.g. zoekt-sourcegraph/...
  artifact_uri  TEXT,                               -- r2://..., https://..., or service-local pointer
  content_hash  TEXT,
  metadata_json TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, artifact_type, commit_sha, language)
);

CREATE INDEX IF NOT EXISTS idx_code_index_artifacts_repo_type
  ON code_index_artifacts (repo_id, artifact_type, status);

-- ---- SCIP-derived symbol / xref facts --------------------------------------
-- These tables intentionally coexist with the MVP code_edges graph. code_edges
-- remains a cheap fallback; SCIP rows provide precise cross-language
-- definitions, references, implementations, and overrides when available.
CREATE TABLE IF NOT EXISTS scip_symbols (
  id                  TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  symbol              TEXT NOT NULL,
  display_name        TEXT,
  kind                TEXT NOT NULL DEFAULT 'unknown',
  language            TEXT,
  path                TEXT NOT NULL,
  start_line          INTEGER NOT NULL,
  end_line            INTEGER NOT NULL,
  definition_chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL,
  commit_sha          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, symbol, path, start_line, end_line)
);

CREATE INDEX IF NOT EXISTS idx_scip_symbols_repo_symbol
  ON scip_symbols (repo_id, symbol);

CREATE INDEX IF NOT EXISTS idx_scip_symbols_repo_display
  ON scip_symbols (repo_id, display_name);

CREATE TABLE IF NOT EXISTS scip_references (
  id               TEXT PRIMARY KEY,
  repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  symbol_id        TEXT NOT NULL REFERENCES scip_symbols(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'reference', -- definition|reference|implementation|override
  path             TEXT NOT NULL,
  start_line       INTEGER NOT NULL,
  end_line         INTEGER NOT NULL,
  enclosing_symbol TEXT,
  commit_sha       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, symbol_id, role, path, start_line, end_line)
);

CREATE INDEX IF NOT EXISTS idx_scip_references_symbol_role
  ON scip_references (symbol_id, role);

CREATE INDEX IF NOT EXISTS idx_scip_references_repo_path
  ON scip_references (repo_id, path);

-- ---- Per-repo indexing lifecycle / progress ---------------------------------
CREATE TABLE IF NOT EXISTS repo_index_status (
  repo_id        TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING|INDEXING|READY|FAILED
  job_type       TEXT,                              -- FULL_INDEX|INCREMENTAL_INDEX
  total_files    INTEGER DEFAULT 0,
  indexed_files  INTEGER DEFAULT 0,
  total_chunks   INTEGER DEFAULT 0,
  commit_sha     TEXT,
  error          TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Slack workspace install records ----------------------------------------
CREATE TABLE IF NOT EXISTS slack_workspaces (
  id            TEXT PRIMARY KEY,                   -- Slack team id
  team_name     TEXT,
  bot_token     TEXT,                               -- xoxb- (prototype: usually a single env token)
  bot_user_id   TEXT,
  installed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Multi-tenant admin portal ---------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id                       TEXT PRIMARY KEY,         -- Slack team id for v1
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
  role            TEXT NOT NULL DEFAULT 'ADMIN',     -- ADMIN|MEMBER
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

-- Repos from a GitHub App install webhook before the tenant links the install.
CREATE TABLE IF NOT EXISTS pending_installation_repos (
  installation_id  INTEGER NOT NULL,
  repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  full_name        TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (installation_id, repo_id)
);

-- Repos currently granted to a GitHub App installation. This is the live
-- install permission cache used for tenant repo selection and token routing.
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

CREATE TABLE IF NOT EXISTS tenant_repos (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  installation_id INTEGER,
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
  status        TEXT NOT NULL DEFAULT 'PENDING',    -- PENDING|COMPLETE|FAILED
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

-- ---- Impact-aware staged PR plans ------------------------------------------
-- Large/breaking changes are modeled as an ordered plan rather than one
-- unbounded diff. create-pr can open the first safe PR while preserving the
-- blast-radius plan for follow-up automation and review.
CREATE TABLE IF NOT EXISTS staged_pr_plans (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  repo_id          TEXT REFERENCES repos(id) ON DELETE SET NULL,
  source_channel   TEXT,
  source_thread_ts TEXT,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PLANNED', -- PLANNED|ACTIVE|COMPLETE|BLOCKED|CANCELLED
  impact_json      TEXT NOT NULL DEFAULT '{}',
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staged_pr_steps (
  id                       TEXT PRIMARY KEY,
  plan_id                  TEXT NOT NULL REFERENCES staged_pr_plans(id) ON DELETE CASCADE,
  step_order               INTEGER NOT NULL,
  repo_id                  TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|READY|OPENED|MERGED|BLOCKED|SKIPPED
  depends_on_step_ids_json TEXT NOT NULL DEFAULT '[]',
  validation_json          TEXT NOT NULL DEFAULT '[]',
  rollback_json            TEXT NOT NULL DEFAULT '[]',
  pr_url                   TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plan_id, step_order)
);

-- ---- Static repo allowlist (prototype auth) ---------------------------------
CREATE TABLE IF NOT EXISTS prototype_repo_allowlist (
  repo_id     TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,           -- boolean
  added_by    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- CI triage: per-repo Slack notify channel --------------------------------
CREATE TABLE IF NOT EXISTS ci_notify_channels (
  repo_id     TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL,                        -- Slack channel id ("C…")
  added_by    TEXT,                                 -- Slack user id
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- CI triage: processed-run dedupe -----------------------------------------
-- One row per (run, attempt) claims the triage; dedupes GitHub webhook
-- redeliveries and queue retries. message_ts is set once posted to Slack.
CREATE TABLE IF NOT EXISTS ci_triage_runs (
  run_id      INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  repo_id     TEXT NOT NULL,
  message_ts  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, run_attempt)
);

CREATE TABLE IF NOT EXISTS tenant_ci_triage_runs (
  run_id        INTEGER NOT NULL,
  run_attempt   INTEGER NOT NULL,
  slack_team_id TEXT NOT NULL,
  repo_id       TEXT NOT NULL,
  message_ts    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, run_attempt, slack_team_id)
);

-- ---- Future production auth (NOT used by prototype) --------------------------
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,               -- internal user id
  slack_user_id     TEXT UNIQUE,
  slack_team_id     TEXT,
  github_login      TEXT,
  github_id         INTEGER,
  github_token_enc  TEXT,                           -- encrypted per-user OAuth token (future)
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS github_user_repo_permissions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  permission   TEXT NOT NULL,                       -- read|write|admin
  synced_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, repo_id)
);

-- ---- Indexes ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_files_repo_id          ON files (repo_id);
CREATE INDEX IF NOT EXISTS idx_chunks_repo_id         ON chunks (repo_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file_id         ON chunks (file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol          ON chunks (symbol);
CREATE INDEX IF NOT EXISTS idx_chunks_path            ON chunks (path);
CREATE INDEX IF NOT EXISTS idx_chunks_repo_type       ON chunks (repo_id, chunk_type);
CREATE INDEX IF NOT EXISTS idx_edges_repo_id          ON code_edges (repo_id);
CREATE INDEX IF NOT EXISTS idx_edges_from_node_id     ON code_edges (from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_node_id       ON code_edges (to_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_repo_type        ON code_edges (repo_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_repo_type_to_symbol ON code_edges (repo_id, edge_type, to_symbol);
CREATE INDEX IF NOT EXISTS idx_allowlist_enabled      ON prototype_repo_allowlist (enabled);
CREATE INDEX IF NOT EXISTS idx_ci_triage_repo         ON ci_triage_runs (repo_id);
CREATE INDEX IF NOT EXISTS idx_tenant_ci_triage_repo  ON tenant_ci_triage_runs (repo_id, slack_team_id);
CREATE INDEX IF NOT EXISTS idx_perms_user             ON github_user_repo_permissions (user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_user    ON tenant_members (slack_user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_repos_repo      ON tenant_repos (repo_id);
CREATE INDEX IF NOT EXISTS idx_tenant_repos_enabled   ON tenant_repos (tenant_id, enabled);
CREATE INDEX IF NOT EXISTS idx_tenant_github_install  ON tenant_github_installations (installation_id);
CREATE INDEX IF NOT EXISTS idx_pending_install_repos  ON pending_installation_repos (installation_id);
CREATE INDEX IF NOT EXISTS idx_github_install_repos   ON github_installation_repos (repo_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant    ON audit_events (tenant_id, created_at);
