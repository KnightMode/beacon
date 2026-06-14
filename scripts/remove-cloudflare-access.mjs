#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PAGES_ENVIRONMENTS = ['production', 'preview'];

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const hostname = cleanHostname(process.env.ACCESS_SITE_HOSTNAME || 'askbeacon.dev');
const pagesProjectName = process.env.ACCESS_PAGES_PROJECT_NAME?.trim() || 'beacon';
const pagesEnvironment = normalizePagesEnvironment(process.env.ACCESS_PAGES_ENVIRONMENT || 'production');
const appName = process.env.ACCESS_APP_NAME?.trim() || 'Beacon admin portal';
const protectedPaths = splitCsv(
  process.env.ACCESS_PROTECTED_PATHS || '/admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*',
).map(normalizeAccessPath);

const apps = await findAccessApplications();

if (apps.length === 0) {
  console.log(`No Cloudflare Access applications found for admin paths on ${hostname}.`);
} else {
  for (const app of apps) {
    await cfFetch(`/access/apps/${app.id}`, { method: 'DELETE' });
    console.log(`Deleted Cloudflare Access application ${app.id} for ${app.domain}.`);
  }
}

await removePagesAccessVars();
console.log(`Removed Pages project ${pagesProjectName} ${pagesEnvironment} Access runtime vars.`);
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
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.success) {
    const messages = payload?.errors?.map((error) => error.message).join('; ');
    const hint = permissionHint(pathname, response.status);
    throw new Error(
      `Cloudflare API ${response.status} ${options.method || 'GET'} ${pathname}: ${messages || response.statusText}${hint}`,
    );
  }

  return payload;
}

async function removePagesAccessVars() {
  const project = await getPagesProject();
  const deploymentConfigs = pagesDeploymentConfigs(project, pagesEnvironment, (envVars) => {
    return {
      ...envVars,
      ADMIN_CF_ACCESS_ISSUER: null,
      ADMIN_CF_ACCESS_AUD: null,
      ADMIN_CF_ACCESS_ALLOWED_EMAILS: null,
      ADMIN_CF_ACCESS_ALLOWED_DOMAINS: null,
    };
  });

  await cfFetch(`/pages/projects/${encodeURIComponent(pagesProjectName)}`, {
    method: 'PATCH',
    body: { deployment_configs: deploymentConfigs },
  });
}

async function getPagesProject() {
  const response = await cfFetch(`/pages/projects/${encodeURIComponent(pagesProjectName)}`);
  return response.result;
}

function pagesDeploymentConfigs(project, targetEnvironment, updateEnvVars) {
  const configs = project.deployment_configs || {};
  const failOpen = sharedFailOpen(configs);
  const deploymentConfigs = {};

  for (const environment of PAGES_ENVIRONMENTS) {
    const config = configs[environment] || {};
    const envVars = { ...(config.env_vars || {}) };
    deploymentConfigs[environment] = {
      ...config,
      fail_open: failOpen,
      env_vars: environment === targetEnvironment ? updateEnvVars(envVars) : envVars,
    };
  }

  return deploymentConfigs;
}

function sharedFailOpen(configs) {
  if (typeof configs.production?.fail_open === 'boolean') return configs.production.fail_open;
  if (typeof configs.preview?.fail_open === 'boolean') return configs.preview.fail_open;
  return false;
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

function normalizePagesEnvironment(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'preview') {
    return normalized;
  }
  throw new Error('ACCESS_PAGES_ENVIRONMENT must be "production" or "preview".');
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function permissionHint(pathname, status) {
  if (status !== 403) {
    return '';
  }

  if (pathname.startsWith('/pages/projects')) {
    return ' Hint: add Cloudflare Pages: Edit to CLOUDFLARE_API_TOKEN.';
  }

  if (pathname.startsWith('/access/apps')) {
    return ' Hint: add Account > Access: Apps and Policies > Edit to CLOUDFLARE_API_TOKEN.';
  }

  return '';
}
