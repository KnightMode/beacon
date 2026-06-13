#!/usr/bin/env node

const API_BASE = 'https://api.cloudflare.com/client/v4';

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const hostname = cleanHostname(process.env.ACCESS_SITE_HOSTNAME || 'beacon-90k.pages.dev');
const appName = process.env.ACCESS_APP_NAME?.trim() || 'Beacon marketing site';
const policyName = process.env.ACCESS_POLICY_NAME?.trim() || 'Allow approved email OTP';
const sessionDuration = process.env.ACCESS_SESSION_DURATION?.trim() || '24h';
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

const otpProvider = await ensureOtpIdentityProvider();
const app = await ensureAccessApplication(otpProvider.id);
const policy = await ensureAccessPolicy(app.id);

console.log(`Cloudflare Access is configured for ${hostname}.`);
console.log(`Application: ${app.name} (${app.id})`);
console.log(`Policy: ${policy.name} (${policy.id})`);
console.log(`Allowed emails: ${allowedEmails.length || 0}`);
console.log(`Allowed email domains: ${allowedDomains.length || 0}`);

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

async function ensureAccessApplication(identityProviderId) {
  const apps = await listAll('/access/apps');
  const existing = apps.find((candidate) => {
    return candidate.domain === hostname || candidate.name === appName;
  });

  if (existing) {
    console.log(`Using existing Access application: ${existing.id}`);
    return ensureApplicationAllowsIdentityProvider(existing, identityProviderId);
  }

  const response = await cfFetch('/access/apps', {
    method: 'POST',
    body: {
      name: appName,
      type: 'self_hosted',
      domain: hostname,
      session_duration: sessionDuration,
      allowed_idps: [identityProviderId],
      policies: [policyPayload()],
    },
  });

  console.log(`Created Access application: ${response.result.id}`);
  return response.result;
}

async function ensureApplicationAllowsIdentityProvider(app, identityProviderId) {
  const allowedIdps = normalizeAllowedIdps(app.allowed_idps);

  if (allowedIdps.length === 0 || allowedIdps.includes(identityProviderId)) {
    return app;
  }

  const response = await cfFetch(`/access/apps/${app.id}`, {
    method: 'PUT',
    body: {
      name: app.name || appName,
      type: app.type || 'self_hosted',
      domain: app.domain || hostname,
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
    throw new Error(
      `Cloudflare API ${response.status} ${options.method || 'GET'} ${pathname}: ${messages || response.statusText}`,
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

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
