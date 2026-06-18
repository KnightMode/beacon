/**
 * Shared TypeScript types: job payloads, chunk types, graph edges, and D1 row
 * shapes. These are the contract between the webhook worker, queue, indexer,
 * and slack-bot worker.
 */

import type {
  ChunkType,
  CodeIndexArtifactStatus,
  CodeIndexArtifactType,
  EdgeType,
  IndexStatus,
  JobType,
  ScipReferenceRole,
  ScipSymbolKind,
  StagedPrPlanStatus,
  StagedPrStepStatus,
} from './constants.js';

// ---------------------------------------------------------------------------
// Queue job payloads
// ---------------------------------------------------------------------------

/** Base fields shared by every indexing job placed on the Cloudflare Queue. */
export interface BaseIndexJob {
  jobType: JobType;
  repoId: string;
  repoFullName: string;
  /** Slack workspace tenant id for tenant-scoped indexing. Omitted only by legacy dev/prototype jobs. */
  tenantId?: string;
  /** GitHub App installation that grants access to this repo. Required for tenant-scoped indexing. */
  installationId?: number;
  /** Commit sha to index against; defaults to repo default branch HEAD. */
  commitSha?: string;
  enqueuedAt: string;
}

export interface FullIndexJob extends BaseIndexJob {
  jobType: 'FULL_INDEX';
  /**
   * Force a true full re-chunk/re-embed, bypassing the up-to-date shortcut,
   * diff-based conversion, and unchanged-content skips. Needed after chunker
   * or embedding-model changes.
   */
  force?: boolean;
}

export interface IncrementalIndexJob extends BaseIndexJob {
  jobType: 'INCREMENTAL_INDEX';
  /** Files added/modified since last index — re-chunked. */
  changedFiles: string[];
  /** Files removed — their chunks/vectors are deleted. */
  removedFiles: string[];
}

export type IndexJob = FullIndexJob | IncrementalIndexJob;

/**
 * CI-failure triage job, produced by the github-webhook worker when a
 * workflow_run completes with conclusion=failure on an allowlisted repo,
 * consumed by the slack-bot worker. Deliberately NOT part of the IndexJob
 * union: it travels on its own queue (`scintel-triage-jobs`).
 */
export interface TriageJob {
  jobType: 'CI_TRIAGE';
  repoId: string;
  repoFullName: string;
  /** workflow_run.id — stable across re-runs of the same workflow run. */
  runId: number;
  /** workflow_run.run_attempt — increments on re-run; dedupe key with runId. */
  runAttempt: number;
  workflowName: string;
  headBranch: string;
  headSha: string;
  runHtmlUrl: string;
  /** Slack workspace for per-tenant bot token and notify-channel lookup. */
  slackTeamId?: string;
  enqueuedAt: string;
}

// ---------------------------------------------------------------------------
// Chunk / edge domain types (produced by the indexer)
// ---------------------------------------------------------------------------

export interface CodeChunk {
  id: string;
  repoId: string;
  fileId: string;
  path: string;
  language: string | null;
  chunkType: ChunkType;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  commitSha: string | null;
  /** Symbols imported within this chunk (used to build IMPORTS edges). */
  imports: string[];
  /** Symbols called within this chunk (used to build CALLS edges). */
  calls: string[];
  redacted: boolean;
}

export interface CodeEdge {
  id: string;
  repoId: string;
  edgeType: EdgeType;
  fromNodeId: string;
  toNodeId: string;
  fromSymbol: string | null;
  toSymbol: string | null;
  fileId: string | null;
  startLine: number | null;
}

export interface CodeIndexArtifact {
  id: string;
  repoId: string;
  artifactType: CodeIndexArtifactType;
  status: CodeIndexArtifactStatus;
  commitSha: string;
  language: string | null;
  producer: string;
  artifactUri: string | null;
  contentHash: string | null;
  metadataJson: string | null;
  error: string | null;
}

export interface ScipSymbol {
  id: string;
  repoId: string;
  symbol: string;
  displayName: string | null;
  kind: ScipSymbolKind;
  language: string | null;
  path: string;
  startLine: number;
  endLine: number;
  definitionChunkId: string | null;
  commitSha: string | null;
}

export interface ScipReference {
  id: string;
  repoId: string;
  symbolId: string;
  role: ScipReferenceRole;
  path: string;
  startLine: number;
  endLine: number;
  enclosingSymbol: string | null;
  commitSha: string | null;
}

/** Metadata stored alongside each vector in Vectorize. */
export interface VectorMetadata {
  tenant_id?: string;
  repo_id: string;
  repo_full_name: string;
  path: string;
  language: string;
  chunk_type: string;
  symbol: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
  [key: string]: string | number | boolean | undefined;
}

// ---------------------------------------------------------------------------
// D1 row shapes (SQLite -> JS). Booleans come back as 0/1 integers.
// ---------------------------------------------------------------------------

export interface RepoRow {
  id: string;
  github_id: number | null;
  full_name: string;
  owner: string;
  name: string;
  default_branch: string;
  private: number;
  indexing_status: IndexStatus;
  last_indexed_sha: string | null;
  last_indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  repo_id: string;
  path: string;
  language: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  id: string;
  repo_id: string;
  file_id: string;
  path: string;
  language: string | null;
  chunk_type: ChunkType;
  symbol: string | null;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  commit_sha: string | null;
  embedded: number;
  redacted: number;
  created_at: string;
}

export interface CodeEdgeRow {
  id: string;
  repo_id: string;
  edge_type: EdgeType;
  from_node_id: string;
  to_node_id: string;
  from_symbol: string | null;
  to_symbol: string | null;
  file_id: string | null;
  start_line: number | null;
  created_at: string;
}

export interface CodeIndexArtifactRow {
  id: string;
  repo_id: string;
  artifact_type: CodeIndexArtifactType;
  status: CodeIndexArtifactStatus;
  commit_sha: string;
  language: string | null;
  producer: string;
  artifact_uri: string | null;
  content_hash: string | null;
  metadata_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScipSymbolRow {
  id: string;
  repo_id: string;
  symbol: string;
  display_name: string | null;
  kind: ScipSymbolKind;
  language: string | null;
  path: string;
  start_line: number;
  end_line: number;
  definition_chunk_id: string | null;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScipReferenceRow {
  id: string;
  repo_id: string;
  symbol_id: string;
  role: ScipReferenceRole;
  path: string;
  start_line: number;
  end_line: number;
  enclosing_symbol: string | null;
  commit_sha: string | null;
  created_at: string;
}

export interface StagedPrPlanRow {
  id: string;
  tenant_id: string | null;
  repo_id: string | null;
  source_channel: string | null;
  source_thread_ts: string | null;
  title: string;
  status: StagedPrPlanStatus;
  impact_json: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface StagedPrStepRow {
  id: string;
  plan_id: string;
  step_order: number;
  repo_id: string;
  title: string;
  status: StagedPrStepStatus;
  depends_on_step_ids_json: string;
  validation_json: string;
  rollback_json: string;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepoIndexStatusRow {
  repo_id: string;
  status: IndexStatus;
  job_type: JobType | null;
  total_files: number;
  indexed_files: number;
  total_chunks: number;
  commit_sha: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface SlackWorkspaceRow {
  id: string;
  team_name: string | null;
  bot_token: string | null;
  bot_user_id: string | null;
  installed_at: string;
}

export interface PrototypeRepoAllowlistRow {
  repo_id: string;
  full_name: string;
  enabled: number;
  added_by: string | null;
  created_at: string;
}

export interface UserRow {
  id: string;
  slack_user_id: string | null;
  slack_team_id: string | null;
  github_login: string | null;
  github_id: number | null;
  github_token_enc: string | null;
  created_at: string;
  updated_at: string;
}

export interface GithubUserRepoPermissionRow {
  id: string;
  user_id: string;
  repo_id: string;
  permission: 'read' | 'write' | 'admin';
  synced_at: string;
}

// ---------------------------------------------------------------------------
// Retrieval types (slack-bot worker)
// ---------------------------------------------------------------------------

export interface RetrievedChunk {
  id: string;
  repoId: string;
  repoFullName: string;
  path: string;
  language: string | null;
  chunkType: ChunkType;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  /** Commit sha the chunk was indexed at (for permalink citations). */
  commitSha: string | null;
  /** Combined relevance score after reranking. */
  score: number;
  /** Where the chunk came from, for debugging/observability. */
  source: 'lexical' | 'vector' | 'graph' | 'zoekt' | 'scip';
  /** All retrieval stages that produced this chunk after de-duping. */
  sources?: Array<RetrievedChunk['source']>;
}

export interface Citation {
  repoFullName: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Commit sha for a stable permalink; falls back to HEAD when absent. */
  commitSha?: string | null;
  /** Retrieval stage that produced this citation, for eval/debugging. */
  source?: RetrievedChunk['source'];
  /** All retrieval stages that found this citation's chunk. */
  sources?: Array<RetrievedChunk['source']>;
}
