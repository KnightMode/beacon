import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexJob } from '@scintel/shared';
import type { Env } from '../src/env.js';
import { handleIndexBatch } from '../src/consumer.js';

function tenantIndexJob(): IndexJob {
  return {
    jobType: 'FULL_INDEX',
    repoId: 'acme/app',
    repoFullName: 'Acme/app',
    tenantId: 'T_ACME',
    installationId: 12345,
    enqueuedAt: '2026-06-14T00:00:00.000Z',
  };
}

describe('handleIndexBatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches tenant index jobs to the GitHub Actions pipeline with installation auth metadata', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [{ body: tenantIndexJob(), ack, retry }],
    } as unknown as MessageBatch<IndexJob>;
    const env = {
      PIPELINE_DISPATCH_REPO: 'KnightMode/beacon',
      PIPELINE_DISPATCH_TOKEN: 'dispatch-token',
      PIPELINE_DISPATCH_EVENT: 'index-repo',
    } as unknown as Env;

    await handleIndexBatch(batch, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/KnightMode/beacon/dispatches',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      event_type: 'index-repo',
      client_payload: {
        repo: 'Acme/app',
        repoId: 'acme/app',
        tenantId: 'T_ACME',
        installationId: 12345,
        jobType: 'FULL_INDEX',
      },
    });
  });

  it('fails loudly when neither Actions dispatch nor hosted indexer dispatch is configured', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [{ body: tenantIndexJob(), ack, retry }],
    } as unknown as MessageBatch<IndexJob>;

    await handleIndexBatch(batch, {} as Env);

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });
});
