/**
 * D1 access over the Cloudflare REST API (the indexer is a Node process and
 * cannot use Worker bindings).
 * Docs: POST /accounts/{acct}/d1/database/{db}/query  { sql, params }
 */

import type { IndexerConfig } from '../config.js';
import { CloudflareApiClient } from './api.js';

interface D1QueryResult<T> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export class D1Client {
  private readonly databaseId: string;
  private readonly api: CloudflareApiClient;

  constructor(config: IndexerConfig) {
    this.databaseId = config.cloudflare.d1DatabaseId;
    this.api = new CloudflareApiClient(
      config.cloudflare.accountId,
      config.cloudflare.apiToken,
    );
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.api.accountRequest<D1QueryResult<T>[]>(
      `/d1/database/${this.databaseId}/query`,
      {
        method: 'POST',
        body: { sql, params },
        label: 'D1 query',
      },
    );
    return result[0]?.results ?? [];
  }

  /** Convenience for statements with no result rows. */
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }
}
