-- Zoekt + SCIP foundation tables.
--
-- This migration is additive. The existing chunks, chunks_fts, Vectorize
-- vectors, and MVP code_edges graph continue to work while the richer
-- code-intelligence substrate is populated.

CREATE TABLE IF NOT EXISTS code_index_artifacts (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  commit_sha    TEXT NOT NULL,
  language      TEXT NOT NULL DEFAULT '',
  producer      TEXT NOT NULL,
  artifact_uri  TEXT,
  content_hash  TEXT,
  metadata_json TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, artifact_type, commit_sha, language)
);

CREATE INDEX IF NOT EXISTS idx_code_index_artifacts_repo_type
  ON code_index_artifacts (repo_id, artifact_type, status);

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
  role             TEXT NOT NULL DEFAULT 'reference',
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

CREATE TABLE IF NOT EXISTS staged_pr_plans (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  repo_id          TEXT REFERENCES repos(id) ON DELETE SET NULL,
  source_channel   TEXT,
  source_thread_ts TEXT,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PLANNED',
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
  status                   TEXT NOT NULL DEFAULT 'PENDING',
  depends_on_step_ids_json TEXT NOT NULL DEFAULT '[]',
  validation_json          TEXT NOT NULL DEFAULT '[]',
  rollback_json            TEXT NOT NULL DEFAULT '[]',
  pr_url                   TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plan_id, step_order)
);
