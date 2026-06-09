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

  // Secrets
  GITHUB_WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  INDEXER_SHARED_SECRET: string;
}
