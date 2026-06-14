#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4';

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const pagesProjectName = process.env.PAGES_PROJECT_NAME?.trim() || 'beacon';
const domain = cleanHostname(process.env.PAGES_CUSTOM_DOMAIN || 'askbeacon.dev');

await ensurePagesDomain();

console.log(`Custom domain ${domain} is attached to Pages project ${pagesProjectName}.`);

async function ensurePagesDomain() {
  const existing = await listPagesDomains();
  if (existing.some((entry) => entry.name === domain)) {
    console.log(`Pages project ${pagesProjectName} already has domain ${domain}.`);
    return;
  }

  const response = await cfFetch(`/pages/projects/${pagesProjectName}/domains`, {
    method: 'POST',
    body: { name: domain },
  });

  console.log(`Attached ${response.result.name} (status: ${response.result.status}).`);
}

async function listPagesDomains() {
  const response = await cfFetch(`/pages/projects/${pagesProjectName}/domains`);
  return response.result || [];
}

async function cfFetch(pathname, options = {}) {
  const response = await fetch(`${API_BASE}/accounts/${accountId}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const message = payload.errors?.map((error) => error.message).join('; ') || response.statusText;
    throw new Error(`Cloudflare API ${pathname} failed (${response.status}): ${message}`);
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
