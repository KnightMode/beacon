import { handleError, json, readSession, tenantSummary } from '../../_lib/admin.js';

const encoder = new TextEncoder();
const POLL_INTERVAL_MS = 2500;
const STREAM_TTL_MS = 60_000;

export async function onRequestGet(context) {
  try {
    const session = await readSession(context);
    if (!session?.tenantId) return json({ authenticated: false }, 401);

    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let pollTimeoutId;
        let closeTimeoutId;

        const close = () => {
          if (closed) return;
          closed = true;
          if (pollTimeoutId) clearTimeout(pollTimeoutId);
          if (closeTimeoutId) clearTimeout(closeTimeoutId);
          try {
            controller.close();
          } catch {
            // The client may have already disconnected.
          }
        };
        cleanup = close;

        const emit = (event, payload) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
            );
          } catch {
            close();
          }
        };

        const tick = async () => {
          if (closed) return;
          try {
            emit('snapshot', {
              authenticated: true,
              ...(await tenantSummary(context.env, session.tenantId)),
            });
          } catch {
            emit('error', { error: 'Could not refresh admin status.' });
          }
          if (!closed) pollTimeoutId = setTimeout(tick, POLL_INTERVAL_MS);
        };

        context.request.signal.addEventListener('abort', close, { once: true });
        closeTimeoutId = setTimeout(close, STREAM_TTL_MS);
        void tick();
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
