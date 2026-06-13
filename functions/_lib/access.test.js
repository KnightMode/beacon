import { describe, expect, it } from 'vitest';
import { requireAdminAccess, shouldProtectAdminPath, verifyAccessJwt } from './access.js';

const ISSUER = 'https://beacon.cloudflareaccess.com';
const AUDIENCE = 'admin-aud';

describe('admin Cloudflare Access protection', () => {
  it('matches only the admin surface', () => {
    expect(shouldProtectAdminPath('/admin')).toBe(true);
    expect(shouldProtectAdminPath('/admin/onboarding/')).toBe(true);
    expect(shouldProtectAdminPath('/api/admin/repos')).toBe(true);
    expect(shouldProtectAdminPath('/oauth/slack/callback')).toBe(true);
    expect(shouldProtectAdminPath('/oauth/github/callback')).toBe(true);
    expect(shouldProtectAdminPath('/api/public')).toBe(false);
    expect(shouldProtectAdminPath('/administrator')).toBe(false);
  });

  it('skips Access verification for local portal development by default', async () => {
    const result = await requireAdminAccess({
      request: new Request('http://127.0.0.1:8788/admin/onboarding/'),
      env: {},
    });
    expect(result).toBeNull();
  });

  it('fails closed on non-local admin routes when Access env is missing', async () => {
    await expect(
      requireAdminAccess({
        request: new Request('https://beacon.example.com/admin/onboarding/'),
        env: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('verifies a signed Access JWT and accepts any configured audience', async () => {
    const { privateKey, publicJwk } = await keyPair();
    const token = await signJwt(privateKey, {
      iss: ISSUER,
      aud: ['preview-aud', AUDIENCE],
      email: 'admin@example.com',
      exp: 1_900_000_000,
    });

    const payload = await verifyAccessJwt(token, {
      issuer: ISSUER,
      audiences: [AUDIENCE],
      jwk: publicJwk,
      now: 1_800_000_000,
    });

    expect(payload.email).toBe('admin@example.com');
  });

  it('rejects a valid token for an unapproved Access identity', async () => {
    const { privateKey, publicJwk } = await keyPair();
    const token = await signJwt(privateKey, {
      iss: ISSUER,
      aud: AUDIENCE,
      email: 'user@outside.example',
      exp: 1_900_000_000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { 'content-type': 'application/json' },
      });
    try {
      await expect(
        requireAdminAccess({
          request: new Request('https://beacon.example.com/admin/onboarding/', {
            headers: { 'cf-access-jwt-assertion': token },
          }),
          env: {
            ADMIN_CF_ACCESS_ISSUER: ISSUER,
            ADMIN_CF_ACCESS_AUD: AUDIENCE,
            ADMIN_CF_ACCESS_ALLOWED_DOMAINS: 'example.com',
          },
        }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    await expect(
      verifyAccessJwt(token, {
        issuer: ISSUER,
        audiences: [AUDIENCE],
        jwk: publicJwk,
        now: 1_800_000_000,
      }),
    ).resolves.toMatchObject({ email: 'user@outside.example' });
  });
});

async function keyPair() {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...publicJwk, kid: 'test-key', kty: 'RSA' },
  };
}

async function signJwt(privateKey, payload) {
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
}

function base64url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
