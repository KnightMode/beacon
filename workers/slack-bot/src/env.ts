export interface Env {
  // Bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  CREATE_PR_QUEUE?: Queue<import('./jobs/createPrQueue.js').CreatePrJob>;

  // Vars
  EMBEDDING_MODEL: string;
  LLM_MODEL: string;
  /** Set to "false" to disable the agentic retrieval planner loop for Q&A. */
  AGENTIC_RETRIEVAL?: string;
  SLACK_BOT_USER_ID: string;
  /** Default `owner/repo` when create-PR issues omit a repo (optional). */
  DEFAULT_PR_REPO?: string;

  // Secrets
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  /** Fine-grained PAT: Read for review; Write for create-PR (Contents + Pull requests). */
  GITHUB_PAT?: string;
}
