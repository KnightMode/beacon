/**
 * D1 access over the Cloudflare REST API (the indexer is a Node process and
 * cannot use Worker bindings).
 * Docs: POST /accounts/{acct}/d1/database/{db}/query  { sql, params }
 */

import type { IndexerConfig } from '../config.js';

const BASE = 'https://api.cloudflare.com/client/v4';

interface D1QueryResult<T> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export class D1Client {
  private readonly accountId: string;
  private readonly databaseId: string;
  private readonly apiToken: string;

  constructor(config: IndexerConfig) {
    this.accountId = config.cloudflare.accountId;
    this.databaseId = config.cloudflare.d1DatabaseId;
    this.apiToken = config.cloudflare.apiToken;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const url = `${BASE}/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`D1 query failed: ${res.status} ${text.slice(0, 500)}`);
    }
    const body = (await res.json()) as {
      success: boolean;
      errors?: Array<{ message: string }>;
      result: D1QueryResult<T>[];
    };
    if (!body.success) {
      const msg = body.errors?.map((e) => e.message).join('; ') ?? 'unknown';
      throw new Error(`D1 query error: ${msg}`);
    }
    return body.result[0]?.results ?? [];
  }

  /** Convenience for statements with no result rows. */
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }
}
