import { createAppAuth } from '@octokit/auth-app';
import { request as octokitRequest } from '@octokit/request';

const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'beacon-admin-portal';
const GITHUB_REPO_PAGE_SIZE = 100;

const baseRequest = octokitRequest.defaults({
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': GITHUB_API_VERSION,
  },
});

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
  const request = installationRequest(env, installationId);
  if (!request) return null;

  const needle = String(options.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const page = Math.max(Number(options.page) || 1, 1);
  const maxPages = Math.min(Math.max(Number(options.maxPages) || 30, 1), 50);

  if (!needle) {
    const batch = await fetchInstallationRepoPage(request, page);
    return {
      repos: batch.slice(0, limit),
      page,
      hasMore: batch.length === GITHUB_REPO_PAGE_SIZE,
      totalScanned: batch.length,
    };
  }

  const matches = [];
  let githubPage = 1;
  let hasMore = false;
  let totalScanned = 0;
  while (githubPage <= maxPages && matches.length < limit) {
    const batch = await fetchInstallationRepoPage(request, githubPage);
    totalScanned += batch.length;
    if (batch.length === 0) break;
    for (const repo of batch) {
      if (repo.fullName.toLowerCase().includes(needle)) {
        matches.push(repo);
        if (matches.length >= limit) break;
      }
    }
    if (batch.length < GITHUB_REPO_PAGE_SIZE) break;
    hasMore = true;
    githubPage += 1;
  }

  return {
    repos: matches,
    page: 1,
    hasMore,
    totalScanned,
  };
}

function installationRequest(env, installationId) {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  if (!appId || !privateKey) return null;

  const auth = createAppAuth({
    appId,
    privateKey: toPkcs8IfPkcs1(privateKey),
    installationId: Number(installationId),
    request: baseRequest,
  });

  return baseRequest.defaults({
    request: { hook: auth.hook },
  });
}

async function fetchInstallationRepoPage(request, page) {
  const response = await githubRequest(
    request,
    'GET /installation/repositories',
    { per_page: GITHUB_REPO_PAGE_SIZE, page },
    'GitHub repo list',
  );
  return (response.data.repositories ?? []).map((repo) => ({
    fullName: repo.full_name,
    githubId: repo.id,
    defaultBranch: repo.default_branch || 'main',
    private: Boolean(repo.private),
  }));
}

async function githubRequest(request, route, parameters, label) {
  try {
    return await request(route, parameters);
  } catch (err) {
    throw new Error(`${label} failed${githubStatus(err)}: ${githubErrorMessage(err)}`);
  }
}

function githubStatus(err) {
  return err?.status ? ` (${err.status})` : '';
}

function githubErrorMessage(err) {
  const data = err?.response?.data;
  if (typeof data === 'string') return data.slice(0, 200);
  if (data?.message) return String(data.message).slice(0, 200);
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    return data.errors
      .map((entry) => entry.message || entry.code || JSON.stringify(entry))
      .join('; ')
      .slice(0, 200);
  }
  return String(err?.message || 'unknown error').slice(0, 200);
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

function toPkcs8IfPkcs1(pem) {
  return /BEGIN RSA PRIVATE KEY/.test(pem)
    ? derToPem('PRIVATE KEY', wrapPkcs1AsPkcs8(pemToDer(pem)))
    : pem;
}

function derToPem(label, der) {
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
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
