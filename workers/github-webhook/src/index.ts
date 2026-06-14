/**
 * GitHub webhook worker entrypoint.
 *
 * Routes:
 *   POST /webhooks/github  - verify HMAC, handle installation/push events
 *   POST /admin/index      - bearer-protected manual FULL_INDEX enqueue
 *   GET  /health           - liveness probe
 *
 * Also runs the Cloudflare Queue consumer that dispatches jobs to the indexer.
 */

import type { IndexJob } from '@scintel/shared';
import type { Env } from './env.js';
import { verifyGitHubSignature } from './signature.js';
import { handleWebhookEvent, json } from './webhook.js';
import { handleAdminIndex } from './admin.js';
import { handleIndexBatch } from './consumer.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'github-webhook' });
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/github') {
      return handleGithubWebhook(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/admin/index') {
      return handleAdminIndex(env, request);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  async queue(batch: MessageBatch<IndexJob>, env: Env): Promise<void> {
    await handleIndexBatch(batch, env);
  },
};

async function handleGithubWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  const valid = await verifyGitHubSignature(
    rawBody,
    signature,
    env.GITHUB_WEBHOOK_SECRET,
  );
  if (!valid) {
    return json({ ok: false, error: 'invalid signature' }, 401);
  }

  const event = request.headers.get('x-github-event') ?? 'unknown';
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  return handleWebhookEvent(env, event, payload, ctx);
}
