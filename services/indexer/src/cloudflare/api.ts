const BASE_URL = 'https://api.cloudflare.com/client/v4';

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

    const res = await fetch(`${BASE_URL}/accounts/${this.accountId}${pathname}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    });
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
