export interface Env {
  // Bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  CREATE_PR_QUEUE?: Queue<import('./jobs/createPrQueue.js').CreatePrJob>;
  ANSWER_QUEUE?: Queue<import('./jobs/answerQueue.js').AnswerJob>;

  // Vars
  EMBEDDING_MODEL: string;
  LLM_MODEL: string;
  /** Set to "false" to disable the agentic retrieval planner loop for Q&A. */
  AGENTIC_RETRIEVAL?: string;
  SLACK_BOT_USER_ID: string;
  /** Default `owner/repo` when create-PR issues omit a repo (optional). */
  DEFAULT_PR_REPO?: string;
  /** Repo whose index.yml workflow is fired (repository_dispatch) for "index owner/repo". */
  INDEX_DISPATCH_REPO?: string;
  /** GitHub App id used to mint installation tokens for tenant repo indexing. */
  GITHUB_APP_ID?: string;

  // Secrets
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  /** Enables POST /eval/ask for the eval harness; route is 404 when unset. */
  EVAL_TOKEN?: string;
  /** Fine-grained PAT for PR create/review agent actions (not used for tenant indexing). */
  GITHUB_PAT?: string;
  /** GitHub App private key for tenant repo indexing via installation tokens. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Token allowed to fire repository_dispatch on INDEX_DISPATCH_REPO. */
  PIPELINE_DISPATCH_TOKEN?: string;
  /** AES-GCM secret used to decrypt per-tenant Slack bot tokens from the portal. */
  SLACK_TOKEN_ENCRYPTION_SECRET?: string;
}
