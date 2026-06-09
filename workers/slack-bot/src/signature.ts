/**
 * Slack request signature verification.
 * Slack signs `v0:{timestamp}:{rawBody}` with SLACK_SIGNING_SECRET (HMAC-SHA256)
 * and sends `X-Slack-Signature: v0=<hex>` plus `X-Slack-Request-Timestamp`.
 * Requests older than the allowed skew are rejected (replay protection).
 */

import { SLACK_TIMESTAMP_SKEW_SECONDS } from '@scintel/shared';

const encoder = new TextEncoder();

export interface SlackVerifyInput {
  signingSecret: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  rawBody: string;
  nowSeconds?: number;
}

export async function verifySlackSignature(
  input: SlackVerifyInput,
): Promise<boolean> {
  const { signingSecret, signatureHeader, timestampHeader, rawBody } = input;
  if (!signatureHeader || !timestampHeader) return false;
  if (!signatureHeader.startsWith('v0=')) return false;

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SLACK_TIMESTAMP_SKEW_SECONDS) return false;

  const basestring = `v0:${timestampHeader}:${rawBody}`;
  const expected = `v0=${await hmacSha256Hex(signingSecret, basestring)}`;
  return timingSafeEqual(signatureHeader, expected);
}

export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
