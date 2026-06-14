/**
 * Indexer configuration, loaded from environment variables (.env supported via
 * dotenv). The indexer is a plain Node process and therefore reaches D1 /
 * Vectorize / Workers AI through the Cloudflare REST API.
 */

import 'dotenv/config';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_LLM_MODEL,
} from '@scintel/shared';

export interface IndexerConfig {
  port: number;
  indexerSharedSecret: string;

  github: {
    pat?: string;
    appId?: string;
    appPrivateKey?: string;
  };

  cloudflare: {
    accountId: string;
    apiToken: string;
    d1DatabaseId: string;
    vectorizeIndex: string;
  };

  models: {
    embedding: string;
    embeddingDimensions: number;
    llm: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

/** Loads + validates config. Throws on missing required values. */
export function loadConfig(): IndexerConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    indexerSharedSecret: required('INDEXER_SHARED_SECRET'),
    github: {
      pat: optional('GITHUB_PAT'),
      appId: optional('GITHUB_APP_ID'),
      appPrivateKey: optional('GITHUB_APP_PRIVATE_KEY'),
    },
    cloudflare: {
      accountId: required('CLOUDFLARE_ACCOUNT_ID'),
      apiToken: required('CLOUDFLARE_API_TOKEN'),
      d1DatabaseId: required('CLOUDFLARE_D1_DATABASE_ID'),
      vectorizeIndex: process.env.CLOUDFLARE_VECTORIZE_INDEX?.trim() || 'code-chunks',
    },
    models: {
      embedding: process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
      embeddingDimensions: Number(
        process.env.EMBEDDING_DIMENSIONS ?? DEFAULT_EMBEDDING_DIMENSIONS,
      ),
      llm: process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL,
    },
  };
}
