/**
 * Workers AI embeddings over the Cloudflare REST API.
 * Docs: POST /accounts/{acct}/ai/run/{model}  { text: string[] }
 */

import type { IndexerConfig } from '../config.js';
import { CloudflareApiClient } from './api.js';

export class WorkersAIClient {
  private readonly model: string;
  private readonly api: CloudflareApiClient;

  constructor(config: IndexerConfig) {
    this.model = config.models.embedding;
    this.api = new CloudflareApiClient(
      config.cloudflare.accountId,
      config.cloudflare.apiToken,
    );
  }

  /** Embed a batch of texts; returns one vector per input, in order. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const result = await this.api.accountRequest<{ data: number[][] }>(
      `/ai/run/${this.model}`,
      {
        method: 'POST',
        body: { text: texts },
        label: 'embeddings',
      },
    );
    return result.data;
  }
}
