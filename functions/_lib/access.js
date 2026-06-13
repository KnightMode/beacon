import { HttpError } from './admin.js';

const ACCESS_HEADER = 'cf-access-jwt-assertion';
const ADMIN_ACCESS_PATHS = [
  '/admin',
  '/api/admin',
  '/oauth/slack/callback',
  '/oauth/github/callback',
];
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map();

export function shouldProtectAdminPath(pathname) {
  return ADMIN_ACCESS_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function requireAdminAccess(context) {
  const { request, env } = context;
  if (!shouldProtectAdminPath(new URL(request.url).pathname)) return null;
  if (isLocalRequest(request) && env.ADMIN_CF_ACCESS_ENFORCE_LOCAL !== 'true') return null;

  const issuer = normalizeIssuer(env.ADMIN_CF_ACCESS_ISSUER);
  const audiences = splitCsv(env.ADMIN_CF_ACCESS_AUD);
  if (!issuer || audiences.length === 0) {
    throw new HttpError(403, 'Admin access is unavailable.');
  }

  const token = request.headers.get(ACCESS_HEADER);
  if (!token) throw new HttpError(403, 'Missing Cloudflare Access token.');

  const payload = await verifyAccessJwt(token, { issuer, audiences });
  assertAllowedAccessIdentity(payload, env);
  return payload;
}

export async function verifyAccessJwt(token, options) {
  const { issuer, audiences, jwk, now = Math.floor(Date.now() / 1000), fetcher = fetch } = options;
  const [headerB64, payloadB64, signatureB64, extra] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64 || extra !== undefined) {
    throw new HttpError(403, 'Invalid Cloudflare Access token.');
  }

  const header = jsonFromBase64url(headerB64);
  if (header.alg !== 'RS256' || !header.kid) {
    throw new HttpError(403, 'Invalid Cloudflare Access token.');
  }

  const payload = jsonFromBase64url(payloadB64);
  assertAccessClaims(payload, issuer, audiences, now);

  const keyJwk = jwk || (await getAccessJwk(issuer, header.kid, fetcher));
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...keyJwk, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64urlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new HttpError(403, 'Invalid Cloudflare Access token.');

  return payload;
}

function assertAccessClaims(payload, issuer, audiences, now) {
  if (payload.iss !== issuer) throw new HttpError(403, 'Invalid Cloudflare Access issuer.');
  const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter(Boolean);
  if (!tokenAudiences.some((audience) => audiences.includes(audience))) {
    throw new HttpError(403, 'Invalid Cloudflare Access audience.');
  }
  if (!payload.exp || payload.exp <= now) throw new HttpError(403, 'Expired Cloudflare Access token.');
  if (payload.nbf && payload.nbf > now) throw new HttpError(403, 'Inactive Cloudflare Access token.');
}

function assertAllowedAccessIdentity(payload, env) {
  const allowedEmails = splitCsv(env.ADMIN_CF_ACCESS_ALLOWED_EMAILS).map((email) => email.toLowerCase());
  const allowedDomains = splitCsv(env.ADMIN_CF_ACCESS_ALLOWED_DOMAINS).map((domain) =>
    domain.replace(/^@/, '').toLowerCase(),
  );
  if (allowedEmails.length === 0 && allowedDomains.length === 0) return;

  const email = String(payload.email || '').trim().toLowerCase();
  const domain = email.split('@')[1] || '';
  if (email && (allowedEmails.includes(email) || allowedDomains.includes(domain))) return;
  throw new HttpError(403, 'Cloudflare Access identity is not allowed for the admin portal.');
}

async function getAccessJwk(issuer, kid, fetcher) {
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const cached = jwksCache.get(certsUrl);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    const key = cached.keys.find((candidate) => candidate.kid === kid);
    if (key) return key;
  }

  const response = await fetcher(certsUrl);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload?.keys)) {
    throw new HttpError(403, 'Unable to verify Cloudflare Access token.');
  }
  jwksCache.set(certsUrl, { keys: payload.keys, expiresAt: now + JWKS_CACHE_TTL_MS });

  const key = payload.keys.find((candidate) => candidate.kid === kid);
  if (!key) throw new HttpError(403, 'Unknown Cloudflare Access key.');
  return key;
}

function isLocalRequest(request) {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function normalizeIssuer(value) {
  const issuer = value?.trim();
  return issuer ? issuer.replace(/\/+$/, '') : '';
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function jsonFromBase64url(value) {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(value)));
  } catch {
    throw new HttpError(403, 'Invalid Cloudflare Access token.');
  }
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
