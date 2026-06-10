-- =============================================================================
-- Migration 0001: BM25 lexical search via FTS5
-- =============================================================================
-- For deployments whose D1 database was created before chunks_fts existed in
-- schema.sql. Fresh installs get all of this from schema.sql directly.
--
-- Apply:  wrangler d1 execute scintel --remote --file=packages/shared/migrations/0001_chunks_fts.sql
-- (run with --local too if you use a local dev database)
-- =============================================================================

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
