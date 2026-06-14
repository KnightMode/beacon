#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PAGES_ENVIRONMENTS = ['production', 'preview'];

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const hostname = cleanHostname(process.env.ACCESS_SITE_HOSTNAME || 'askbeacon.dev');
const pagesProjectName = process.env.ACCESS_PAGES_PROJECT_NAME?.trim() || 'beacon';
const pagesEnvironment = normalizePagesEnvironment(process.env.ACCESS_PAGES_ENVIRONMENT || 'production');
const appName = process.env.ACCESS_APP_NAME?.trim() || 'Beacon';
// Friendly labels so each protected path becomes a readable Access app name
// (e.g. the login screen reads "Log in to Beacon onboarding portal").
const PATH_LABELS = {
  '/admin*': 'onboarding portal',
  '/api/admin*': 'admin API',
  '/oauth/slack/callback*': 'Slack connection',
  '/oauth/github/callback*': 'GitHub connection',
};
const organizationName = process.env.ACCESS_ORGANIZATION_NAME?.trim() || 'Beacon';
const authDomain = cleanAuthDomain(process.env.ACCESS_AUTH_DOMAIN || 'beacon-90k.cloudflareaccess.com');
const policyName = process.env.ACCESS_POLICY_NAME?.trim() || 'Allow approved email OTP';
const sessionDuration = process.env.ACCESS_SESSION_DURATION?.trim() || '24h';
const protectedPaths = splitCsv(
  process.env.ACCESS_PROTECTED_PATHS || '/admin*,/api/admin*,/oauth/slack/callback*,/oauth/github/callback*',
).map(normalizeAccessPath);
const allowedEmails = splitCsv(process.env.ACCESS_ALLOWED_EMAILS || 'differentialcircuit@gmail.com');
const allowedDomains = splitCsv(process.env.ACCESS_ALLOWED_DOMAINS).map((domain) =>
  domain.replace(/^@/, '').toLowerCase(),
);
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
const pagesD1Binding = String(firstValue(process.env.PAGES_D1_BINDING, 'DB')).trim();
const pagesD1DatabaseName = String(firstValue(process.env.PAGES_D1_DATABASE_NAME, 'scintel')).trim();
const pagesD1DatabaseId = String(
  firstValue(
    process.env.PAGES_D1_DATABASE_ID,
    process.env.CLOUDFLARE_D1_DATABASE_ID,
    '27722a79-10d9-4bfc-aa53-1d65a80c8f79',
  ),
).trim();

if (allowedEmails.length === 0 && allowedDomains.length === 0) {
  throw new Error('Set ACCESS_ALLOWED_EMAILS and/or ACCESS_ALLOWED_DOMAINS.');
}

const includeRules = [
  ...allowedEmails.map((email) => ({ email: { email } })),
  ...allowedDomains.map((domain) => ({ email_domain: { domain } })),
];

await ensureAccessOrganization();
const otpProvider = await ensureOtpIdentityProvider();
const results = [];
for (const domain of protectedPaths.map((path) => `${hostname}${path}`)) {
  const app = await ensureAccessApplication(otpProvider.id, domain);
  const policy = await ensureAccessPolicy(app.id);
  results.push({ app, policy, domain });
}

const accessAudiences = results.map(({ app }) => app.aud).filter(Boolean).join(',');
await updatePagesAccessVars(accessAudiences);

console.log(`Cloudflare Access is configured for admin paths on ${hostname}.`);
console.log(`Organization auth domain: ${authDomain}`);
for (const { app, policy, domain } of results) {
  console.log(`Application: ${app.name} (${app.id}) -> ${domain}`);
  console.log(`Policy: ${policy.name} (${policy.id})`);
  if (app.aud) console.log(`Audience: ${app.aud}`);
}
console.log(`Allowed emails: ${allowedEmails.length || 0}`);
console.log(`Allowed email domains: ${allowedDomains.length || 0}`);
console.log(`Updated Pages project ${pagesProjectName} ${pagesEnvironment} Access runtime vars.`);
console.log(`Bound D1 database ${pagesD1DatabaseName} to Pages as ${pagesD1Binding}.`);

async function ensureAccessOrganization() {
  try {
    const response = await cfFetch('/access/organizations');
    console.log(`Using existing Zero Trust organization: ${response.result.auth_domain}`);
    return response.result;
  } catch (error) {
    if (!isAccessNotEnabledError(error)) {
      throw error;
    }
  }

  const response = await cfFetch('/access/organizations', {
    method: 'POST',
    body: {
      name: organizationName,
      auth_domain: authDomain,
      session_duration: sessionDuration,
    },
  });

  console.log(`Created Zero Trust organization: ${response.result.auth_domain}`);
  return response.result;
}

async function ensureOtpIdentityProvider() {
  const providers = await listAll('/access/identity_providers');
  const existing = providers.find((provider) => provider.type === 'onetimepin');

  if (existing) {
    console.log(`Using existing One-time PIN identity provider: ${existing.id}`);
    return existing;
  }

  const response = await cfFetch('/access/identity_providers', {
    method: 'POST',
    body: {
      name: 'One-time PIN login',
      type: 'onetimepin',
      config: {},
    },
  });

  console.log(`Created One-time PIN identity provider: ${response.result.id}`);
  return response.result;
}

async function ensureAccessApplication(identityProviderId, domain) {
  const applications = await listAll('/access/apps');
  const existing = applications.find((candidate) => {
    return candidate.domain === domain;
  });

  if (existing) {
    console.log(`Using existing Access application: ${existing.id}`);
    return ensureApplicationAllowsIdentityProvider(existing, identityProviderId, domain);
  }

  const response = await cfFetch('/access/apps', {
    method: 'POST',
    body: {
      name: appDisplayName(domain),
      type: 'self_hosted',
      domain,
      session_duration: sessionDuration,
      allowed_idps: [identityProviderId],
      policies: [policyPayload()],
    },
  });

  console.log(`Created Access application: ${response.result.id}`);
  return response.result;
}

async function ensureApplicationAllowsIdentityProvider(app, identityProviderId, domain) {
  const allowedIdps = normalizeAllowedIdps(app.allowed_idps);
  const desiredName = appDisplayName(domain);
  const hasIdp = allowedIdps.length === 0 || allowedIdps.includes(identityProviderId);
  const nameMatches = app.name === desiredName;

  // Nothing to reconcile — identity provider already allowed and the name is current.
  if (hasIdp && nameMatches) {
    return app;
  }

  const mergedIdps = hasIdp ? allowedIdps : [...allowedIdps, identityProviderId];

  const response = await cfFetch(`/access/apps/${app.id}`, {
    method: 'PUT',
    body: {
      name: desiredName,
      type: app.type || 'self_hosted',
      domain: app.domain || domain,
      allowed_idps: mergedIdps,
      policies: policyReferences(app),
      session_duration: app.session_duration || sessionDuration,
    },
  });

  console.log(`Reconciled Access application ${response.result.id} (name: "${desiredName}")`);
  return response.result;
}

async function ensureAccessPolicy(appId) {
  const policies = await listAll(`/access/apps/${appId}/policies`);
  const existing = policies.find((candidate) => candidate.name === policyName);

  if (!existing) {
    const response = await cfFetch(`/access/apps/${appId}/policies`, {
      method: 'POST',
      body: policyPayload(),
    });

    console.log(`Created Access policy: ${response.result.id}`);
    return response.result;
  }

  const response = await cfFetch(`/access/apps/${appId}/policies/${existing.id}`, {
    method: 'PUT',
    body: {
      ...policyPayload(),
      id: existing.id,
    },
  });

  console.log(`Updated Access policy: ${response.result.id}`);
  return response.result;
}

async function updatePagesAccessVars(accessAudiences) {
  if (!accessAudiences) {
    throw new Error('Cloudflare Access did not return any application audience tags.');
  }

  const project = await getPagesProject();
  const deploymentConfigs = pagesDeploymentConfigs(project, pagesEnvironment, (config) => ({
    ...config,
    env_vars: adminRuntimeVars(config.env_vars, accessAudiences),
    d1_databases: adminD1Databases(config.d1_databases),
  }));

  await cfFetch(`/pages/projects/${encodeURIComponent(pagesProjectName)}`, {
    method: 'PATCH',
    body: { deployment_configs: deploymentConfigs },
  });
}

async function getPagesProject() {
  const response = await cfFetch(`/pages/projects/${encodeURIComponent(pagesProjectName)}`);
  return response.result;
}

function adminRuntimeVars(existingEnvVars, accessAudiences) {
  const envVars = {
    ...existingEnvVars,
    ADMIN_CF_ACCESS_ISSUER: plainTextVar(`https://${authDomain}`),
    ADMIN_CF_ACCESS_AUD: plainTextVar(accessAudiences),
    ADMIN_CF_ACCESS_ALLOWED_EMAILS: plainTextVar(allowedEmails.join(',')),
    ADMIN_CF_ACCESS_ALLOWED_DOMAINS: plainTextVar(allowedDomains.join(',')),
  };

  for (const [name, value] of Object.entries(pagePlainVars)) {
    envVars[name] = plainTextVar(value);
  }
  for (const [name, value] of Object.entries(pageSecretVars)) {
    envVars[name] = secretTextVar(value);
  }

  assertAdminRuntimeConfigured(envVars);
  return envVars;
}

function adminD1Databases(existingD1Databases) {
  assertD1BindingConfigured();
  return {
    ...existingD1Databases,
    [pagesD1Binding]: {
      ...existingD1Databases?.[pagesD1Binding],
      id: pagesD1DatabaseId,
    },
  };
}

function assertAdminRuntimeConfigured(envVars) {
  const missing = [
    'SLACK_CLIENT_ID',
    'ADMIN_SESSION_SECRET',
    'SLACK_CLIENT_SECRET',
    'SLACK_TOKEN_ENCRYPTION_SECRET',
    'GITHUB_APP_SLUG',
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'INDEXER_URL',
    'INDEXER_SHARED_SECRET',
  ].filter((name) => !envVars[name]);
  if (missing.length === 0) return;

  throw new Error(
    `Missing Pages admin runtime config: ${missing.join(', ')}. ` +
      'Set matching GitHub Actions variables/secrets or provide workflow inputs before rerunning Configure site Access.',
  );
}

function assertD1BindingConfigured() {
  const missing = [];
  if (!pagesD1Binding) missing.push('PAGES_D1_BINDING');
  if (!pagesD1DatabaseId) missing.push('PAGES_D1_DATABASE_ID');
  if (missing.length === 0) return;

  throw new Error(
    `Missing Pages D1 binding config: ${missing.join(', ')}. ` +
      'Set matching GitHub Actions variables or provide workflow inputs before rerunning Configure site Access.',
  );
}

function pagesDeploymentConfigs(project, targetEnvironment, updateConfig) {
  const configs = project.deployment_configs || {};
  const failOpen = sharedFailOpen(configs);
  const deploymentConfigs = {};

  for (const environment of PAGES_ENVIRONMENTS) {
    const config = configs[environment] || {};
    const nextConfig = {
      ...config,
      fail_open: failOpen,
      env_vars: { ...(config.env_vars || {}) },
      d1_databases: { ...(config.d1_databases || {}) },
    };
    deploymentConfigs[environment] = environment === targetEnvironment ? updateConfig(nextConfig) : nextConfig;
  }

  return deploymentConfigs;
}

function sharedFailOpen(configs) {
  if (typeof configs.production?.fail_open === 'boolean') return configs.production.fail_open;
  if (typeof configs.preview?.fail_open === 'boolean') return configs.preview.fail_open;
  return false;
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

function normalizeAllowedIdps(allowedIdps) {
  if (!Array.isArray(allowedIdps)) {
    return [];
  }

  return allowedIdps
    .map((provider) => {
      if (typeof provider === 'string') {
        return provider;
      }

      return provider?.id;
    })
    .filter(Boolean);
}

function policyReferences(app) {
  if (!Array.isArray(app.policies) || app.policies.length === 0) {
    return undefined;
  }

  return app.policies
    .map((policy, index) => {
      if (typeof policy === 'string') {
        return policy;
      }

      if (policy?.id) {
        return {
          id: policy.id,
          precedence: policy.precedence ?? index + 1,
        };
      }

      return undefined;
    })
    .filter(Boolean);
}

function policyPayload() {
  return {
    name: policyName,
    decision: 'allow',
    precedence: 1,
    include: includeRules,
    session_duration: sessionDuration,
  };
}

function appDisplayName(domain) {
  const path = domain.slice(hostname.length) || '/*';
  const label = PATH_LABELS[path] || path;
  return `${appName} ${label}`;
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

function splitCsv(value) {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function cleanHostname(value) {
  return value
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
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

function cleanAuthDomain(value) {
  const domain = cleanHostname(value);
  if (domain.endsWith('.cloudflareaccess.com')) {
    return domain;
  }

  return `${domain}.cloudflareaccess.com`;
}

function isAccessNotEnabledError(error) {
  return error instanceof Error && error.message.includes('access.api.error.not_enabled');
}

function permissionHint(pathname, status) {
  if (status !== 403) {
    return '';
  }

  if (pathname.startsWith('/access/apps')) {
    return ' Hint: add Account > Access: Apps and Policies > Edit to CLOUDFLARE_API_TOKEN.';
  }

  if (pathname.startsWith('/access/organizations') || pathname.startsWith('/access/identity_providers')) {
    return ' Hint: add Account > Access: Organizations, Identity Providers, and Groups > Edit to CLOUDFLARE_API_TOKEN.';
  }

  if (pathname.startsWith('/pages/projects')) {
    return ' Hint: add Cloudflare Pages: Edit to CLOUDFLARE_API_TOKEN.';
  }

  return '';
}
