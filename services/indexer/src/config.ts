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

  codeIntel: {
    mode: 'off' | 'best_effort' | 'required';
    workDir?: string;
    artifactBaseUri?: string;
    zoektIndexBin: string;
    zoektIndexDir?: string;
    scipCommandsJson?: string;
    scipFactsPath?: string;
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
    codeIntel: {
      mode: codeIntelMode(process.env.CODE_INTEL_MODE),
      workDir: optional('CODE_INTEL_WORK_DIR'),
      artifactBaseUri: optional('CODE_INTEL_ARTIFACT_BASE_URI'),
      zoektIndexBin: process.env.ZOEKT_INDEX_BIN?.trim() || 'zoekt-index',
      zoektIndexDir: optional('ZOEKT_INDEX_DIR'),
      scipCommandsJson: optional('SCIP_COMMANDS_JSON'),
      scipFactsPath: optional('SCIP_FACTS_PATH'),
    },
  };
}

function codeIntelMode(value: string | undefined): 'off' | 'best_effort' | 'required' {
  const normalized = (value ?? 'off').trim().toLowerCase();
  if (normalized === 'required') return 'required';
  if (normalized === 'best_effort' || normalized === 'best-effort' || normalized === 'true') {
    return 'best_effort';
  }
  return 'off';
}
