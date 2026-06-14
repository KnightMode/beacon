export interface Env {
  // Bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  CREATE_PR_QUEUE?: Queue<import('./jobs/createPrQueue.js').CreatePrJob>;
  ANSWER_QUEUE?: Queue<import('./jobs/answerQueue.js').AnswerJob>;
  INDEX_QUEUE?: Queue<import('@scintel/shared').IndexJob>;

  // Vars
  EMBEDDING_MODEL: string;
  LLM_MODEL: string;
  /** Set to "false" to disable the agentic retrieval planner loop for Q&A. */
  AGENTIC_RETRIEVAL?: string;
  SLACK_BOT_USER_ID: string;
  /** Default `owner/repo` when create-PR issues omit a repo (optional). */
  DEFAULT_PR_REPO?: string;
  /** Legacy non-tenant repo whose index.yml workflow receives repository_dispatch events. */
  INDEX_DISPATCH_REPO?: string;
  BEACON_LOCAL_E2E?: string;

  // Secrets
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  /** Enables POST /eval/ask for the eval harness; route is 404 when unset. */
  EVAL_TOKEN?: string;
  /** Legacy non-tenant PAT; tenant traffic must use GitHub App installation tokens. */
  GITHUB_PAT?: string;
  /** GitHub App credentials used for tenant-scoped GitHub API calls. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** AES-GCM secret used to decrypt per-tenant Slack bot tokens from the portal. */
  SLACK_TOKEN_ENCRYPTION_SECRET?: string;
}
