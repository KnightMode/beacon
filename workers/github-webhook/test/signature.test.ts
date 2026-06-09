import { describe, it, expect } from 'vitest';
import {
  verifyGitHubSignature,
  hmacSha256Hex,
  timingSafeEqual,
} from '../src/signature.js';

const SECRET = 'test-webhook-secret';

describe('verifyGitHubSignature', () => {
  it('accepts a valid signature', async () => {
    const body = JSON.stringify({ action: 'created', hello: 'world' });
    const digest = await hmacSha256Hex(SECRET, body);
    const ok = await verifyGitHubSignature(body, `sha256=${digest}`, SECRET);
    expect(ok).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const body = JSON.stringify({ action: 'created' });
    const digest = await hmacSha256Hex(SECRET, body);
    const ok = await verifyGitHubSignature(
      body + 'x',
      `sha256=${digest}`,
      SECRET,
    );
    expect(ok).toBe(false);
  });

  it('rejects a missing/malformed header', async () => {
    expect(await verifyGitHubSignature('{}', null, SECRET)).toBe(false);
    expect(await verifyGitHubSignature('{}', 'deadbeef', SECRET)).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
});
