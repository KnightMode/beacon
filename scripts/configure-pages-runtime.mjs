#!/usr/bin/env node
/**
 * Sync admin Pages runtime configuration without touching Cloudflare Access.
 * This is safe to run on every Pages deploy and preserves existing vars.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const pagesProjectName = process.env.ACCESS_PAGES_PROJECT_NAME?.trim()
  || process.env.PAGES_PROJECT_NAME?.trim()
  || 'beacon';
const pagesEnvironment = normalizePagesEnvironment(
  process.env.ACCESS_PAGES_ENVIRONMENT || process.env.PAGES_ENVIRONMENT || 'production',
);
const pagesD1Binding = String(firstValue(process.env.PAGES_D1_BINDING, 'DB')).trim();
const pagesD1DatabaseId = String(
  firstValue(
    process.env.PAGES_D1_DATABASE_ID,
    process.env.CLOUDFLARE_D1_DATABASE_ID,
    '27722a79-10d9-4bfc-aa53-1d65a80c8f79',
  ),
).trim();

const pagePlainVars = compactVars({
  SLACK_CLIENT_ID: firstValue(process.env.PAGES_SLACK_CLIENT_ID, process.env.SLACK_CLIENT_ID),
  GITHUB_APP_SLUG: firstValue(process.env.PAGES_GITHUB_APP_SLUG, process.env.GITHUB_APP_SLUG),
  GITHUB_APP_ID: firstValue(process.env.PAGES_GITHUB_APP_ID, process.env.GITHUB_APP_ID),
  INDEXER_URL: firstValue(process.env.PAGES_INDEXER_URL, process.env.INDEXER_URL),
  PIPELINE_DISPATCH_REPO: firstValue(process.env.PAGES_PIPELINE_DISPATCH_REPO, process.env.PIPELINE_DISPATCH_REPO),
  PIPELINE_DISPATCH_EVENT: firstValue(process.env.PAGES_PIPELINE_DISPATCH_EVENT, process.env.PIPELINE_DISPATCH_EVENT),
});

const pageSecretVars = compactVars({
  ADMIN_SESSION_SECRET: firstValue(process.env.PAGES_ADMIN_SESSION_SECRET, process.env.ADMIN_SESSION_SECRET),
  SLACK_CLIENT_SECRET: firstValue(process.env.PAGES_SLACK_CLIENT_SECRET, process.env.SLACK_CLIENT_SECRET),
  SLACK_TOKEN_ENCRYPTION_SECRET: firstValue(
    process.env.PAGES_SLACK_TOKEN_ENCRYPTION_SECRET,
    process.env.SLACK_TOKEN_ENCRYPTION_SECRET,
  ),
  GITHUB_APP_PRIVATE_KEY: firstValue(process.env.PAGES_GITHUB_APP_PRIVATE_KEY, process.env.GITHUB_APP_PRIVATE_KEY),
  INDEXER_SHARED_SECRET: firstValue(process.env.PAGES_INDEXER_SHARED_SECRET, process.env.INDEXER_SHARED_SECRET),
  PIPELINE_DISPATCH_TOKEN: firstValue(process.env.PAGES_PIPELINE_DISPATCH_TOKEN, process.env.PIPELINE_DISPATCH_TOKEN),
});

const project = await cfFetch(`/pages/projects/${encodeURIComponent(pagesProjectName)}`);
const deploymentConfigs = pagesDeploymentConfigs(project.result);
await cfFetch(`/pages/projects/${encodeURIComponent(pagesProjectName)}`, {
  method: 'PATCH',
  body: { deployment_configs: deploymentConfigs },
});

console.log(`Updated Pages project ${pagesProjectName} ${pagesEnvironment} admin runtime vars.`);
console.log(`Bound D1 database ${pagesD1DatabaseId} to Pages as ${pagesD1Binding}.`);

function pagesDeploymentConfigs(project) {
  const configs = project.deployment_configs || {};
  const next = {};

  for (const environment of ['production', 'preview']) {
    const config = configs[environment] || {};
    next[environment] = {
      ...config,
      env_vars: { ...(config.env_vars || {}) },
      d1_databases: { ...(config.d1_databases || {}) },
    };
    if (environment === pagesEnvironment) {
      next[environment].env_vars = adminRuntimeVars(next[environment].env_vars);
      next[environment].d1_databases = adminD1Databases(next[environment].d1_databases);
    }
  }
  return next;
}

function adminRuntimeVars(existingEnvVars) {
  const envVars = { ...existingEnvVars };
  for (const [name, value] of Object.entries(pagePlainVars)) {
    envVars[name] = plainTextVar(value);
  }
  for (const [name, value] of Object.entries(pageSecretVars)) {
    envVars[name] = secretTextVar(value);
  }
  assertRuntimeConfigured(envVars);
  return envVars;
}

function adminD1Databases(existingD1Databases) {
  if (!pagesD1Binding || !pagesD1DatabaseId) {
    throw new Error('PAGES_D1_BINDING and PAGES_D1_DATABASE_ID/CLOUDFLARE_D1_DATABASE_ID are required.');
  }
  return {
    ...existingD1Databases,
    [pagesD1Binding]: {
      ...existingD1Databases?.[pagesD1Binding],
      id: pagesD1DatabaseId,
    },
  };
}

function assertRuntimeConfigured(envVars) {
  const required = [
    'SLACK_CLIENT_ID',
    'ADMIN_SESSION_SECRET',
    'SLACK_CLIENT_SECRET',
    'SLACK_TOKEN_ENCRYPTION_SECRET',
    'GITHUB_APP_SLUG',
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'INDEXER_URL',
    'INDEXER_SHARED_SECRET',
  ];
  const missing = required.filter((name) => !envVars[name]);
  if (missing.length === 0) return;
  throw new Error(
    `Missing Pages admin runtime config: ${missing.join(', ')}. ` +
      'Set matching GitHub Actions variables/secrets before deploying.',
  );
}

async function cfFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}/accounts/${accountId}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((error) => error.message).join('; ') || response.statusText;
    throw new Error(`Cloudflare API ${options.method || 'GET'} ${path} failed: ${message}`);
  }
  return payload;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizePagesEnvironment(value) {
  const normalized = String(value || '').trim();
  if (normalized === 'production' || normalized === 'preview') return normalized;
  throw new Error('Pages environment must be "production" or "preview".');
}

function plainTextVar(value) {
  return { type: 'plain_text', value };
}

function secretTextVar(value) {
  return { type: 'secret_text', value };
}

function compactVars(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ''),
  );
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}
