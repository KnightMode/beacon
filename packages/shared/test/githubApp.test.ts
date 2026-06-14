import { describe, expect, it } from 'vitest';
import {
  createGitHubAppJwt,
  getGitHubInstallationToken,
  normalizePrivateKey,
} from '../src/githubApp.js';

describe('GitHub App auth', () => {
  it('normalizes escaped PEM values from env vars', () => {
    const raw = '"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"';
    expect(normalizePrivateKey(raw)).toBe(
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    );
  });

  it('creates an app JWT with GitHub-compatible claims', async () => {
    const pem = await generatePrivateKeyPem();
    const jwt = await createGitHubAppJwt('123456', pem, 1_700_000_000);
    const [header, payload, signature] = jwt.split('.');

    expect(header).toBeTruthy();
    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(decodeJwtPart(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeJwtPart(payload!)).toEqual({
      iat: 1_699_999_940,
      exp: 1_700_000_540,
      iss: '123456',
    });
  });

  it('caches installation tokens until the skew-adjusted expiry', async () => {
    const pem = await generatePrivateKeyPem();
    let calls = 0;
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      expect(String(url)).toBe(
        'https://api.github.com/app/installations/98765/access_tokens',
      );
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'beacon-github-app',
        'x-github-api-version': '2022-11-28',
      });
      return new Response(
        JSON.stringify({
          token: `installation-token-${calls}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const credentials = { appId: 'cache-test-app', privateKey: pem };
    const first = await getGitHubInstallationToken(credentials, 98765, fetcher);
    const second = await getGitHubInstallationToken(credentials, 98765, fetcher);

    expect(first).toBe('installation-token-1');
    expect(second).toBe('installation-token-1');
    expect(calls).toBe(1);
  });
});

async function generatePrivateKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const body = base64(pkcs8).match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

function decodeJwtPart(part: string): unknown {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(part.length / 4) * 4,
    '=',
  );
  return JSON.parse(atob(padded));
}

function base64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
