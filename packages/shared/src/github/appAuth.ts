/**
 * GitHub App JWT + installation access token helpers.
 * Works in Workers and Node via Web Crypto.
 */

const GITHUB_API = 'https://api.github.com';

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

export function normalizePrivateKey(raw: string | undefined): string {
  if (!raw) return '';
  let trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1);
  }
  if (trimmed.includes('\\n')) {
    return trimmed.replace(/\\n/g, '\n');
  }
  return trimmed;
}

export async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  }));
  const input = new TextEncoder().encode(`${header}.${payload}`);
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, input);
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function createInstallationAccessToken(
  credentials: GitHubAppCredentials,
  installationId: number,
): Promise<string> {
  const privateKey = normalizePrivateKey(credentials.privateKey);
  if (!credentials.appId.trim() || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required to mint installation tokens.');
  }

  const appJwt = await createAppJwt(credentials.appId.trim(), privateKey);
  const res = await githubFetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    appJwt,
    null,
    { method: 'POST' },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub installation token failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new Error('GitHub installation token response missing token.');
  }
  return body.token;
}

async function githubFetch(
  url: string,
  appJwt: string,
  installationToken: string | null,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'beacon-github-app',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${installationToken || appJwt}`,
      ...(init.headers || {}),
    },
  });
}

async function importPrivateKey(pem: string) {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const der = pemToDer(pem);
  const keyData = isPkcs1 ? wrapPkcs1AsPkcs8(der) : der;
  return crypto.subtle.importKey(
    'pkcs8',
    toArrayBuffer(keyData),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pemToDer(pem: string): Uint8Array {
  const normalized = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
    .replace(/-----END RSA PRIVATE KEY-----/g, '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const rsaOid = Uint8Array.of(
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  );
  const algId = encodeAsn1Sequence([rsaOid, Uint8Array.of(0x05, 0x00)]);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const privateKey = encodeAsn1OctetString(pkcs1);
  return encodeAsn1Sequence([version, algId, privateKey]);
}

function encodeAsn1Sequence(parts: Uint8Array[]): Uint8Array {
  const body = concatBytes(parts);
  return concatBytes([Uint8Array.of(0x30), encodeAsn1Length(body.length), body]);
}

function encodeAsn1OctetString(bytes: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(0x04), encodeAsn1Length(bytes.length), bytes]);
}

function encodeAsn1Length(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base64url(value: string | ArrayBuffer | Uint8Array): string {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
