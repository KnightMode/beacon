import { describe, it, expect } from 'vitest';
import {
  verifySlackSignature,
  hmacSha256Hex,
  timingSafeEqual,
} from '../src/signature.js';

const SECRET = 'slack-signing-secret';

async function sign(body: string, ts: number): Promise<string> {
  return `v0=${await hmacSha256Hex(SECRET, `v0:${ts}:${body}`)}`;
}

describe('verifySlackSignature', () => {
  it('accepts a valid, fresh signature', async () => {
    const body = 'token=x&text=hello';
    const ts = 1_700_000_000;
    const sig = await sign(body, ts);
    const ok = await verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sig,
      timestampHeader: String(ts),
      rawBody: body,
      nowSeconds: ts + 10,
    });
    expect(ok).toBe(true);
  });

  it('rejects a stale timestamp (replay)', async () => {
    const body = 'text=hello';
    const ts = 1_700_000_000;
    const sig = await sign(body, ts);
    const ok = await verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sig,
      timestampHeader: String(ts),
      rawBody: body,
      nowSeconds: ts + 60 * 10,
    });
    expect(ok).toBe(false);
  });

  it('rejects a tampered body', async () => {
    const ts = 1_700_000_000;
    const sig = await sign('text=hello', ts);
    const ok = await verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: sig,
      timestampHeader: String(ts),
      rawBody: 'text=goodbye',
      nowSeconds: ts + 5,
    });
    expect(ok).toBe(false);
  });

  it('rejects missing headers', async () => {
    const ok = await verifySlackSignature({
      signingSecret: SECRET,
      signatureHeader: null,
      timestampHeader: null,
      rawBody: '{}',
    });
    expect(ok).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares correctly', () => {
    expect(timingSafeEqual('v0=abc', 'v0=abc')).toBe(true);
    expect(timingSafeEqual('v0=abc', 'v0=abd')).toBe(false);
  });
});
