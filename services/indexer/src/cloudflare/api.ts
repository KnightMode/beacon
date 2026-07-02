import { log } from '../logger.js';

const BASE_URL = 'https://api.cloudflare.com/client/v4';
const REQUEST_ATTEMPTS = 3;

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ message?: string; code?: number | string }>;
}

export class CloudflareApiClient {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
  ) {}

  async accountRequest<T>(
    pathname: string,
    options: {
      method?: string;
      body?: unknown;
      contentType?: string;
      label: string;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiToken}`,
    };
    const body = serializeBody(options.body);
    if (body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/json';
    }

    const url = `${BASE_URL}/accounts/${this.accountId}${pathname}`;
    const res = await this.fetchWithRetry(
      url,
      { method: options.method ?? 'GET', headers, body },
      options.label,
    );
    const text = await res.text();
    const payload = parseEnvelope<T>(text);

    if (!res.ok) {
      throw new Error(`${options.label} failed: ${res.status} ${errorMessage(payload, text)}`);
    }
    if (!payload?.success) {
      throw new Error(`${options.label} error: ${errorMessage(payload, text)}`);
    }
    return payload.result;
  }

  /**
   * fetch with retries on transient failures (5xx, 429, network errors). A
   * single Cloudflare hiccup must not fail a whole indexing run that makes
   * hundreds of API calls; mirrors GitHubClient#request.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    label: string,
    attempts = REQUEST_ATTEMPTS,
  ): Promise<Response> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(url, init);
        if (res.status < 500 && res.status !== 429) return res;
        lastErr = new Error(`status ${res.status}`);
      } catch (err) {
        lastErr = err as Error;
      }
      if (attempt === attempts) {
        if (res) return res; // let the caller parse and surface the final error response
        throw new Error(`${label} failed after ${attempts} attempts: ${url} (${lastErr?.message})`);
      }
      const delay = retryDelayMs(attempt, res);
      log.warn('Cloudflare request failed; retrying', {
        label,
        url,
        attempt,
        error: lastErr?.message,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
    // Unreachable (the loop above always returns or throws), but keeps TS happy.
    throw lastErr ?? new Error(`${label} failed after ${attempts} attempts: ${url}`);
  }
}

/** Retry-After (seconds) if present, else quadratic backoff with jitter. */
function retryDelayMs(attempt: number, res: Response | null): number {
  const retryAfter = res?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return 500 * attempt * attempt + Math.random() * 250;
}

function serializeBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function parseEnvelope<T>(text: string): CloudflareEnvelope<T> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as CloudflareEnvelope<T>;
  } catch {
    return null;
  }
}

function errorMessage(payload: CloudflareEnvelope<unknown> | null, fallback: string): string {
  const messages = payload?.errors
    ?.map((error) => error.message || error.code)
    .filter(Boolean)
    .join('; ');
  return String(messages || fallback || 'unknown').slice(0, 500);
}
