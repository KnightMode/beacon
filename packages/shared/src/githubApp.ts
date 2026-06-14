const GITHUB_API = 'https://api.github.com';
const TOKEN_CACHE_TTL_SKEW_MS = 5 * 60 * 1000;

export interface GitHubAppCredentials {
  appId?: string;
  privateKey?: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, InstallationToken>();

export function normalizePrivateKey(raw?: string): string {
  if (!raw) return '';
  let trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
}

export async function createGitHubAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: appId,
    }),
  );
  const input = new TextEncoder().encode(`${header}.${payload}`);
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key as never, input);
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function getGitHubInstallationToken(
  credentials: GitHubAppCredentials,
  installationId: number,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const appId = credentials.appId?.trim();
  const privateKey = normalizePrivateKey(credentials.privateKey);
  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for GitHub App auth');
  }

  const cacheKey = `${appId}:${installationId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_CACHE_TTL_SKEW_MS > Date.now()) {
    return cached.token;
  }

  const jwt = await createGitHubAppJwt(appId, privateKey);
  const token = await createInstallationAccessToken(jwt, installationId, fetcher);
  tokenCache.set(cacheKey, token);
  return token.token;
}

async function createInstallationAccessToken(
  appJwt: string,
  installationId: number,
  fetcher: typeof fetch,
): Promise<InstallationToken> {
  const res = await fetcher(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appJwt}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'beacon-github-app',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub installation token failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new Error('GitHub installation token response missing token');
  return {
    token: body.token,
    expiresAt: body.expires_at ? Date.parse(body.expires_at) : Date.now() + 55 * 60 * 1000,
  };
}

async function importPrivateKey(pem: string): Promise<unknown> {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const der = pemToDer(pem);
  const keyData = isPkcs1 ? wrapPkcs1AsPkcs8(der) : der;
  return crypto.subtle.importKey(
    'pkcs8',
    toExactArrayBuffer(keyData),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
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
  const bytes =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
