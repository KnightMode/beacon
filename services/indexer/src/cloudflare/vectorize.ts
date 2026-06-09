/**
 * Vectorize access over the Cloudflare REST API (v2). Upsert uses NDJSON.
 * Docs: POST /accounts/{acct}/vectorize/v2/indexes/{name}/upsert
 *       POST /accounts/{acct}/vectorize/v2/indexes/{name}/delete_by_ids
 */

import type { IndexerConfig } from '../config.js';
import type { VectorMetadata } from '@scintel/shared';

const BASE = 'https://api.cloudflare.com/client/v4';

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
    if (vectors.length === 0) return;
    const ndjson = vectors.map((v) => JSON.stringify(v)).join('\n');
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

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const url = `${BASE}/accounts/${this.accountId}/vectorize/v2/indexes/${this.indexName}/delete_by_ids`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ids }),
    });
    await assertOk(res, 'vectorize delete_by_ids');
  }
}

async function assertOk(res: Response, ctx: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${ctx} failed: ${res.status} ${text.slice(0, 500)}`);
  }
}
