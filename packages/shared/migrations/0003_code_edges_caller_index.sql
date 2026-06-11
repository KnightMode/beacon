-- =============================================================================
-- Migration 0003: Covering index for fetchCallers (repo_id, edge_type, to_symbol)
-- =============================================================================
-- Apply:  wrangler d1 execute scintel --remote --file=packages/shared/migrations/0003_code_edges_caller_index.sql
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_edges_repo_type_to_symbol
  ON code_edges (repo_id, edge_type, to_symbol);
