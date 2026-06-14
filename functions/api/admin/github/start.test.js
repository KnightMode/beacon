import { describe, expect, it } from 'vitest';
import { sessionCookie } from '../../../_lib/admin.js';
import { onRequestGet } from './start.js';

describe('github start admin endpoint', () => {
  it('redirects to onboarding when Slack is not connected yet', async () => {
    const request = new Request('https://beacon.example.com/api/admin/github/start');
    const res = await onRequestGet({
      request,
      env: {
        ADMIN_SESSION_SECRET: 'test-secret',
        GITHUB_APP_SLUG: 'beacon-indexer',
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/admin\/onboarding\/\?error=/);
    expect(decodeURIComponent(res.headers.get('location'))).toContain('Connect Slack');
  });

  it('redirects to GitHub App install when the admin session is present', async () => {
    const env = {
      ADMIN_SESSION_SECRET: 'test-secret',
      GITHUB_APP_SLUG: 'beacon-indexer',
    };
    const cookie = await sessionCookie(
      { request: new Request('https://beacon.example.com/admin/onboarding/'), env },
      { tenantId: 'T_BEACON', userId: 'U_ADMIN' },
    );
    const request = new Request('https://beacon.example.com/api/admin/github/start', {
      headers: { cookie },
    });

    const res = await onRequestGet({ request, env });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://github.com/apps/beacon-indexer/installations/new?state=T_BEACON',
    );
    expect(res.headers.get('set-cookie')).toContain('beacon_github_link=');
  });
});
