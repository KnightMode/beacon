#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4';

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const hostname = cleanHostname(process.env.ACCESS_SITE_HOSTNAME || 'beacon-90k.pages.dev');
const appName = process.env.ACCESS_APP_NAME?.trim() || 'Beacon marketing site';

const app = await findAccessApplication();

if (!app) {
  console.log(`No Cloudflare Access application found for ${hostname}. Site should already be public.`);
  process.exit(0);
}

await cfFetch(`/access/apps/${app.id}`, { method: 'DELETE' });

console.log(`Deleted Cloudflare Access application ${app.id} for ${hostname}.`);
console.log('The Pages site should now be publicly accessible once Cloudflare propagation completes.');

async function findAccessApplication() {
  const apps = await listAll('/access/apps');
  return apps.find((candidate) => {
    return candidate.domain === hostname || candidate.name === appName;
  });
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

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
