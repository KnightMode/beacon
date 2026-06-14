import { describe, expect, it } from 'vitest';
import { onRequestGet } from './events.js';

describe('admin events endpoint', () => {
  it('streams a signed-out event when no admin session exists', async () => {
    const res = await onRequestGet({
      request: new Request('https://beacon.example.com/api/admin/events'),
      env: {},
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: signed-out');
    expect(body).toContain('"authenticated":false');
  });
});
