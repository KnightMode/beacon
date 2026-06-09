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

-- ---- Static repo allowlist (prototype auth) ---------------------------------
CREATE TABLE IF NOT EXISTS prototype_repo_allowlist (
  repo_id     TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,           -- boolean
  added_by    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX IF NOT EXISTS idx_allowlist_enabled      ON prototype_repo_allowlist (enabled);
CREATE INDEX IF NOT EXISTS idx_perms_user             ON github_user_repo_permissions (user_id);
