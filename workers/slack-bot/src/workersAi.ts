import type { Env } from './env.js';

export interface WorkersAiRetryOptions {
  label?: string;
  retries?: number;
  baseDelayMs?: number;
  jitterMs?: number;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_JITTER_MS = 200;

export const WORKERS_AI_CAPACITY_MESSAGE =
  "Sorry — the model is temporarily busy. Please try again in a moment.";

export function workersAiErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isWorkersAiTransientError(err: unknown): boolean {
  const message = workersAiErrorMessage(err).toLowerCase();
  return (
    /\b3040\b/.test(message) ||
    /\b429\b/.test(message) ||
    /\b503\b/.test(message) ||
    /\b504\b/.test(message) ||
    /\b7505\b/.test(message) ||
    message.includes('capacity temporarily exceeded') ||
    message.includes('temporarily unavailable') ||
    message.includes('rate limit') ||
    message.includes('rate-limit') ||
    message.includes('throttl')
  );
}

export function userFacingAiError(err: unknown): string {
  if (isWorkersAiTransientError(err)) return WORKERS_AI_CAPACITY_MESSAGE;
  return `Sorry — something went wrong answering that: ${workersAiErrorMessage(err)}`;
}

export async function runWorkersAi<T>(
  env: Pick<Env, 'AI'>,
  model: keyof AiModels,
  input: unknown,
  options: WorkersAiRetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return (await env.AI.run(model, input as never)) as unknown as T;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isWorkersAiTransientError(err)) {
        throw err;
      }

      const delayMs = retryDelayMs(attempt, options);
      console.warn('Workers AI transient failure; retrying', {
        label: options.label,
        model: String(model),
        attempt: attempt + 1,
        retries,
        delayMs,
        error: workersAiErrorMessage(err),
      });
      await sleep(delayMs);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(workersAiErrorMessage(lastErr));
}

function retryDelayMs(attempt: number, options: WorkersAiRetryOptions): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitterMax = options.jitterMs ?? DEFAULT_JITTER_MS;
  const jitter = jitterMax > 0 ? Math.floor(Math.random() * jitterMax) : 0;
  return base * 2 ** attempt + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
