/**
 * Slack bot worker entrypoint.
 *
 * Routes:
 *   POST /slack/commands - `/ask-code` slash command (form-encoded)
 *   POST /slack/events   - Events API (app_mention, reaction_added, assistant)
 *   GET  /health         - liveness probe
 *
 * Every Slack request is signature-verified before processing.
 */

import type { Env } from './env.js';
import { verifySlackSignature } from './signature.js';
import { ackJson, handleSlashCommand, handleEvent } from './slack.js';
import { processCreatePrJob } from './actions/createPr.js';
import type { CreatePrJob } from './jobs/createPrQueue.js';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return ackJson({ ok: true, service: 'slack-bot' });
    }

    if (request.method !== 'POST') {
      return ackJson({ ok: false, error: 'not found' }, 404);
    }

    const rawBody = await request.text();
    const verified = await verifySlackSignature({
      signingSecret: env.SLACK_SIGNING_SECRET,
      signatureHeader: request.headers.get('x-slack-signature'),
      timestampHeader: request.headers.get('x-slack-request-timestamp'),
      rawBody,
    });
    if (!verified) {
      return ackJson({ ok: false, error: 'invalid signature' }, 401);
    }

    if (url.pathname === '/slack/commands') {
      return handleSlashCommand(env, ctx, new URLSearchParams(rawBody));
    }

    if (url.pathname === '/slack/events') {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return ackJson({ ok: false, error: 'invalid JSON' }, 400);
      }
      return handleEvent(env, ctx, body as never);
    }

    return ackJson({ ok: false, error: 'not found' }, 404);
  },

  async queue(batch: MessageBatch<CreatePrJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processCreatePrJob(env, message.body);
        message.ack();
      } catch (err) {
        console.error('create-pr queue job failed', {
          error: (err as Error).message,
          channel: message.body.channel,
        });
        message.retry();
      }
    }
  },
};
