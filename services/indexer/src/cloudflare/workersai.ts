/**
 * Workers AI embeddings over the Cloudflare REST API.
 * Docs: POST /accounts/{acct}/ai/run/{model}  { text: string[] }
 */

import type { IndexerConfig } from '../config.js';

const BASE = 'https://api.cloudflare.com/client/v4';

export class WorkersAIClient {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly model: string;

  constructor(config: IndexerConfig) {
    this.accountId = config.cloudflare.accountId;
    this.apiToken = config.cloudflare.apiToken;
    this.model = config.models.embedding;
  }

  /** Embed a batch of texts; returns one vector per input, in order. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const url = `${BASE}/accounts/${this.accountId}/ai/run/${this.model}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: texts }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`embeddings failed: ${res.status} ${text.slice(0, 500)}`);
    }
    const body = (await res.json()) as {
      success: boolean;
      result: { data: number[][] };
      errors?: Array<{ message: string }>;
    };
    if (!body.success) {
      const msg = body.errors?.map((e) => e.message).join('; ') ?? 'unknown';
      throw new Error(`embeddings error: ${msg}`);
    }
    return body.result.data;
  }
}
