export interface Env {
  // Bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;

  // Vars
  EMBEDDING_MODEL: string;
  LLM_MODEL: string;
  SLACK_BOT_USER_ID: string;

  // Secrets
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
}
