/**
 * Vectorize access over the Cloudflare REST API (v2). Upsert uses NDJSON.
 * Docs: POST /accounts/{acct}/vectorize/v2/indexes/{name}/upsert
 *       POST /accounts/{acct}/vectorize/v2/indexes/{name}/delete_by_ids
 */

import type { IndexerConfig } from '../config.js';
import type { VectorMetadata } from '@scintel/shared';

const BASE = 'https://api.cloudflare.com/client/v4';
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
  private readonly accountId: string;
  private readonly indexName: string;
  private readonly apiToken: string;

  constructor(config: IndexerConfig) {
    this.accountId = config.cloudflare.accountId;
    this.indexName = config.cloudflare.vectorizeIndex;
    this.apiToken = config.cloudflare.apiToken;
  }

  async upsert(vectors: UpsertVector[]): Promise<void> {
    for (const batch of chunked(vectors, UPSERT_BATCH)) {
      const ndjson = batch.map((v) => JSON.stringify(v)).join('\n');
      const url = `${BASE}/accounts/${this.accountId}/vectorize/v2/indexes/${this.indexName}/upsert`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          'content-type': 'application/x-ndjson',
        },
        body: ndjson,
      });
      await assertOk(res, 'vectorize upsert');
    }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const batch of chunked(ids, DELETE_BATCH)) {
      const url = `${BASE}/accounts/${this.accountId}/vectorize/v2/indexes/${this.indexName}/delete_by_ids`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ids: batch }),
      });
      await assertOk(res, 'vectorize delete_by_ids');
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

async function assertOk(res: Response, ctx: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${ctx} failed: ${res.status} ${text.slice(0, 500)}`);
  }
}
