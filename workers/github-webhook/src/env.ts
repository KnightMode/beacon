import type { IndexJob } from '@scintel/shared';

export interface Env {
  // Bindings
  DB: D1Database;
  INDEX_QUEUE: Queue<IndexJob>;
  VECTORIZE: VectorizeIndex;
  AI: Ai;

  // Vars
  REPO_ALLOWLIST: string;
  INDEXER_URL: string;

  // pipeline dispatch (optional; falls back to INDEXER_URL when unset)
  PIPELINE_DISPATCH_REPO?: string;   // e.g. "KnightMode/beacon"
  PIPELINE_DISPATCH_EVENT?: string;  // default "index-repo"
  PIPELINE_DISPATCH_TOKEN?: string;  // secret: GitHub token allowed to create repository_dispatch

  // Secrets
  GITHUB_WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  INDEXER_SHARED_SECRET: string;
}
