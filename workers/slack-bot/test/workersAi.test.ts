import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';
import {
  isWorkersAiTransientError,
  runWorkersAi,
  userFacingAiError,
  WORKERS_AI_CAPACITY_MESSAGE,
} from '../src/workersAi.js';

function fakeEnv(run: (model: keyof AiModels, input: never) => Promise<unknown>): Pick<Env, 'AI'> {
  return { AI: { run } } as unknown as Pick<Env, 'AI'>;
}

describe('Workers AI retry helper', () => {
  it('detects transient Workers AI capacity errors', () => {
    expect(
      isWorkersAiTransientError(
        new Error('3040: Capacity temporarily exceeded, please try again.'),
      ),
    ).toBe(true);
    expect(isWorkersAiTransientError(new Error('429 rate limit exceeded'))).toBe(true);
    expect(isWorkersAiTransientError(new Error('invalid prompt'))).toBe(false);
  });

  it('retries transient errors and returns the successful response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const env = fakeEnv(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('3040: Capacity temporarily exceeded, please try again.');
      }
      return { response: 'ok' };
    });

    await expect(
      runWorkersAi<{ response: string }>(
        env,
        'test-model' as keyof AiModels,
        {},
        { retries: 2, baseDelayMs: 0, jitterMs: 0, label: 'test' },
      ),
    ).resolves.toEqual({ response: 'ok' });
    expect(calls).toBe(2);
    warn.mockRestore();
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    const env = fakeEnv(async () => {
      calls += 1;
      throw new Error('invalid request');
    });

    await expect(
      runWorkersAi(env, 'test-model' as keyof AiModels, {}, { retries: 2 }),
    ).rejects.toThrow('invalid request');
    expect(calls).toBe(1);
  });

  it('hides raw capacity codes in user-facing answer errors', () => {
    expect(
      userFacingAiError(
        new Error('3040: Capacity temporarily exceeded, please try again.'),
      ),
    ).toBe(WORKERS_AI_CAPACITY_MESSAGE);
  });
});
