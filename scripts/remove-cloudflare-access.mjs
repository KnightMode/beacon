#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4';

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const hostname = cleanHostname(process.env.ACCESS_SITE_HOSTNAME || 'beacon-90k.pages.dev');
const appName = process.env.ACCESS_APP_NAME?.trim() || 'Beacon admin portal';
const protectedPaths = splitCsv(
  process.env.ACCESS_PROTECTED_PATHS || '/admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*',
).map(normalizeAccessPath);

const apps = await findAccessApplications();

if (apps.length === 0) {
  console.log(`No Cloudflare Access applications found for admin paths on ${hostname}.`);
  process.exit(0);
}

for (const app of apps) {
  await cfFetch(`/access/apps/${app.id}`, { method: 'DELETE' });
  console.log(`Deleted Cloudflare Access application ${app.id} for ${app.domain}.`);
}

console.log('The admin portal paths should now be publicly accessible once Cloudflare propagation completes.');

async function findAccessApplications() {
  const apps = await listAll('/access/apps');
  const protectedDomains = new Set(protectedPaths.map((path) => `${hostname}${path}`));
  return apps.filter((candidate) => protectedDomains.has(candidate.domain) || candidate.name === appName);
}

async function listAll(pathname) {
  const results = [];
  let page = 1;

  while (true) {
    const separator = pathname.includes('?') ? '&' : '?';
    const response = await cfFetch(`${pathname}${separator}page=${page}&per_page=100`);
    results.push(...(response.result || []));

    const resultInfo = response.result_info;
    if (!resultInfo || page >= resultInfo.total_pages) {
      return results;
    }

    page += 1;
  }
}

async function cfFetch(pathname, options = {}) {
  const response = await fetch(`${API_BASE}/accounts/${accountId}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.success) {
    const messages = payload?.errors?.map((error) => error.message).join('; ');
    throw new Error(`Cloudflare API ${response.status} ${options.method || 'GET'} ${pathname}: ${messages || response.statusText}`);
  }

  return payload;
}

function cleanHostname(value) {
  return value
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function splitCsv(value) {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeAccessPath(value) {
  const path = value.trim();
  if (!path || path === '/') {
    throw new Error('ACCESS_PROTECTED_PATHS must not include the whole site.');
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
