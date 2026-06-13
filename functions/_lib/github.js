const GITHUB_API = 'https://api.github.com';

export async function listInstallationRepositories(env, installationId) {
  const result = await queryInstallationRepositories(env, installationId, {
    page: 1,
    limit: 1000,
    maxPages: 10,
  });
  return result?.repos ?? null;
}

export async function findInstallationRepository(env, installationId, fullName) {
  const result = await queryInstallationRepositories(env, installationId, {
    q: fullName,
    page: 1,
    limit: 100,
    maxPages: 50,
  });
  if (!result) return null;

  const target = fullName.toLowerCase();
  return result.repos.find((repo) => repo.fullName.toLowerCase() === target) || null;
}

export async function queryInstallationRepositories(env, installationId, options = {}) {
  const auth = await getInstallationAuth(env, installationId);
  if (!auth) return null;

  const needle = String(options.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const page = Math.max(Number(options.page) || 1, 1);
  const maxPages = Math.min(Math.max(Number(options.maxPages) || 30, 1), 50);

  if (!needle) {
    const batch = await fetchInstallationRepoPage(auth, page);
    return {
      repos: batch.slice(0, limit),
      page,
      hasMore: batch.length === 100,
      totalScanned: batch.length,
    };
  }

  const matches = [];
  let githubPage = 1;
  let hasMore = false;
  while (githubPage <= maxPages && matches.length < limit) {
    const batch = await fetchInstallationRepoPage(auth, githubPage);
    if (batch.length === 0) break;
    for (const repo of batch) {
      if (repo.fullName.toLowerCase().includes(needle)) {
        matches.push(repo);
        if (matches.length >= limit) break;
      }
    }
    if (batch.length < 100) break;
    hasMore = true;
    githubPage += 1;
  }

  return {
    repos: matches,
    page: 1,
    hasMore,
    totalScanned: githubPage * 100,
  };
}

async function getInstallationAuth(env, installationId) {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  if (!appId || !privateKey) return null;
  const jwt = await createAppJwt(appId, privateKey);
  const token = await createInstallationAccessToken(jwt, installationId);
  return { jwt, token };
}

async function fetchInstallationRepoPage(auth, page) {
  const res = await githubFetch(
    `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`,
    auth.jwt,
    auth.token,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub repo list failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return (body.repositories ?? []).map((repo) => ({
    fullName: repo.full_name,
    githubId: repo.id,
    defaultBranch: repo.default_branch || 'main',
    private: Boolean(repo.private),
  }));
}

async function createInstallationAccessToken(appJwt, installationId) {
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
  const body = await res.json();
  if (!body.token) throw new Error('GitHub installation token response missing token.');
  return body.token;
}

async function githubFetch(url, appJwt, installationToken, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'beacon-admin-portal',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${installationToken || appJwt}`,
      ...(init.headers || {}),
    },
  });
}

async function createAppJwt(appId, privateKeyPem) {
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

async function importPrivateKey(pem) {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const der = pemToDer(pem);
  const keyData = isPkcs1 ? wrapPkcs1AsPkcs8(der) : der;
  return crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function pemToDer(pem) {
  const normalized = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
    .replace(/-----END RSA PRIVATE KEY-----/g, '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

function wrapPkcs1AsPkcs8(pkcs1) {
  const rsaOid = Uint8Array.of(
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  );
  const algId = encodeAsn1Sequence([rsaOid, Uint8Array.of(0x05, 0x00)]);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const privateKey = encodeAsn1OctetString(pkcs1);
  return encodeAsn1Sequence([version, algId, privateKey]);
}

function encodeAsn1Sequence(parts) {
  const body = concatBytes(parts);
  return concatBytes([Uint8Array.of(0x30), encodeAsn1Length(body.length), body]);
}

function encodeAsn1OctetString(bytes) {
  return concatBytes([Uint8Array.of(0x04), encodeAsn1Length(bytes.length), bytes]);
}

function encodeAsn1Length(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function normalizePrivateKey(raw) {
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

function base64url(value) {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
