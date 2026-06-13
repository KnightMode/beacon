#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4';

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const hostname = cleanHostname(process.env.ACCESS_SITE_HOSTNAME || 'beacon-90k.pages.dev');
const appName = process.env.ACCESS_APP_NAME?.trim() || 'Beacon admin portal';
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

console.log(`Cloudflare Access is configured for admin paths on ${hostname}.`);
console.log(`Organization auth domain: ${authDomain}`);
for (const { app, policy, domain } of results) {
  console.log(`Application: ${app.name} (${app.id}) -> ${domain}`);
  console.log(`Policy: ${policy.name} (${policy.id})`);
  if (app.aud) console.log(`Audience: ${app.aud}`);
}
console.log(`Allowed emails: ${allowedEmails.length || 0}`);
console.log(`Allowed email domains: ${allowedDomains.length || 0}`);
console.log(`Set Pages var ADMIN_CF_ACCESS_ISSUER=https://${authDomain}`);
console.log(`Set Pages var ADMIN_CF_ACCESS_AUD=${results.map(({ app }) => app.aud).filter(Boolean).join(',')}`);

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

  if (allowedIdps.length === 0 || allowedIdps.includes(identityProviderId)) {
    return app;
  }

  const response = await cfFetch(`/access/apps/${app.id}`, {
    method: 'PUT',
    body: {
      name: app.name || appDisplayName(domain),
      type: app.type || 'self_hosted',
      domain: app.domain || domain,
      allowed_idps: [...allowedIdps, identityProviderId],
      policies: policyReferences(app),
      session_duration: app.session_duration || sessionDuration,
    },
  });

  console.log(`Added One-time PIN identity provider to Access application: ${response.result.id}`);
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
  return `${appName} ${path}`;
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

  return '';
}
