/**
 * Vectorize access over the Cloudflare REST API (v2). Upsert uses NDJSON.
 * Docs: POST /accounts/{acct}/vectorize/v2/indexes/{name}/upsert
 *       POST /accounts/{acct}/vectorize/v2/indexes/{name}/delete_by_ids
 */

import type { IndexerConfig } from '../config.js';
import type { VectorMetadata } from '@scintel/shared';
import { CloudflareApiClient } from './api.js';

// Vectorize REST limits: delete_by_ids accepts at most 100 ids per request
// (error 40007), upsert at most 5000 vectors per NDJSON body.
const DELETE_BATCH = 100;
const UPSERT_BATCH = 1000;

export interface UpsertVector {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export class VectorizeClient {
  private readonly indexName: string;
  private readonly api: CloudflareApiClient;

  constructor(config: IndexerConfig) {
    this.indexName = config.cloudflare.vectorizeIndex;
    this.api = new CloudflareApiClient(
      config.cloudflare.accountId,
      config.cloudflare.apiToken,
    );
  }

  async upsert(vectors: UpsertVector[]): Promise<void> {
    for (const batch of chunked(vectors, UPSERT_BATCH)) {
      const ndjson = batch.map((v) => JSON.stringify(v)).join('\n');
      await this.api.accountRequest<unknown>(
        `/vectorize/v2/indexes/${this.indexName}/upsert`,
        {
          method: 'POST',
          body: ndjson,
          contentType: 'application/x-ndjson',
          label: 'vectorize upsert',
        },
      );
    }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const batch of chunked(ids, DELETE_BATCH)) {
      await this.api.accountRequest<unknown>(
        `/vectorize/v2/indexes/${this.indexName}/delete_by_ids`,
        {
          method: 'POST',
          body: { ids: batch },
          label: 'vectorize delete_by_ids',
        },
      );
    }
  }
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
