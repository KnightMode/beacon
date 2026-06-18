/**
 * Thin client for the worker's POST /eval/ask route, with a per-question
 * timeout and retries on transient (network / 5xx) failures.
 */

import type { EvalAskResponse } from './types.js';

const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

export interface EvalClientOptions {
  endpoint: string;
  token: string;
  agentic: boolean;
}

export async function askEval(
  opts: EvalClientOptions,
  question: string,
): Promise<EvalAskResponse> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await askOnce(opts, question);
    } catch (err) {
      lastError = err as Error;
      if (!isRetryable(lastError)) break;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }
  throw lastError ?? new Error('eval request failed');
}

async function askOnce(
  opts: EvalClientOptions,
  question: string,
): Promise<EvalAskResponse> {
  const url = new URL('/eval/ask', opts.endpoint);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ question, agentic: opts.agentic }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`/eval/ask ${res.status}: ${body.slice(0, 300)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as EvalAskResponse;
}

function isRetryable(err: Error): boolean {
  const status = (err as Error & { status?: number }).status;
  if (status !== undefined) return status >= 500;
  return true; // network error / timeout
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
