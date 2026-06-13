import { describe, expect, it } from 'vitest';
import { sessionCookie } from '../../../_lib/admin.js';
import { onRequestPost } from './complete.js';

describe('github complete admin endpoint', () => {
  it('rejects manual installation binding without the signed GitHub link cookie', async () => {
    const env = { ADMIN_SESSION_SECRET: 'test-secret' };
    const cookie = await sessionCookie(
      { request: new Request('https://beacon.example.com/admin/onboarding/'), env },
      { tenantId: 'T_BEACON', userId: 'U_ADMIN' },
    );
    const request = new Request('https://beacon.example.com/api/admin/github/complete', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ installationId: 12345 }),
    });

    const res = await onRequestPost({ request, env });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toContain('Start Connect GitHub');
  });
});
