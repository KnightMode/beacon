const COOKIE = 'beacon_admin_session';
const GITHUB_LINK_COOKIE = 'beacon_github_link';
const SESSION_TTL = 60 * 60 * 24 * 14;
const GITHUB_LINK_TTL = 60 * 30;
const STEP_KEYS = ['slack', 'github', 'repos', 'indexing', 'channel', 'first_answer'];

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

export function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

export async function requireSession(context) {
  const session = await readSession(context);
  if (!session?.tenantId) throw new HttpError(401, 'Connect Slack to start admin setup.');
  return session;
}

export async function readSession(context) {
  const raw = cookieValue(context.request.headers.get('cookie') || '', COOKIE);
  if (!raw) return null;
  const [payloadB64, sig] = raw.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = await hmac(context.env.ADMIN_SESSION_SECRET, payloadB64);
  if (!timingSafeEqual(sig, expected)) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export async function sessionCookie(context, payload) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const body = base64urlEncode(JSON.stringify({ ...payload, exp }));
  const sig = await hmac(context.env.ADMIN_SESSION_SECRET, body);
  return `${COOKIE}=${body}.${sig}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly${secureCookieSuffix(context.request)}; SameSite=Lax`;
}

export function oauthStateCookie(request, state) {
  return `beacon_oauth_state=${state}; Path=/; Max-Age=600; HttpOnly${secureCookieSuffix(request)}; SameSite=Lax`;
}

export async function githubLinkCookie(context, tenantId) {
  const exp = Math.floor(Date.now() / 1000) + GITHUB_LINK_TTL;
  const body = base64urlEncode(JSON.stringify({ tenantId, exp }));
  const sig = await hmac(context.env.ADMIN_SESSION_SECRET, body);
  return `${GITHUB_LINK_COOKIE}=${body}.${sig}; Path=/; Max-Age=${GITHUB_LINK_TTL}; HttpOnly${secureCookieSuffix(context.request)}; SameSite=Lax`;
}

export function clearGithubLinkCookie(request) {
  return `${GITHUB_LINK_COOKIE}=; Path=/; Max-Age=0; HttpOnly${secureCookieSuffix(request)}; SameSite=Lax`;
}

export async function readGithubLinkTenant(context) {
  const raw = cookieValue(context.request.headers.get('cookie') || '', GITHUB_LINK_COOKIE);
  if (!raw) return null;
  const [payloadB64, sig] = raw.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = await hmac(context.env.ADMIN_SESSION_SECRET, payloadB64);
  if (!timingSafeEqual(sig, expected)) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload.tenantId || null;
}

export async function resolveGithubTenantId(context, stateParam) {
  const session = await readSession(context);
  const linkedTenant = await readGithubLinkTenant(context);
  if (session?.tenantId) {
    if (stateParam && stateParam !== session.tenantId) {
      throw new HttpError(400, 'Invalid GitHub state. Start Connect GitHub again.');
    }
    if (linkedTenant && linkedTenant !== session.tenantId) {
      throw new HttpError(400, 'Invalid GitHub link cookie. Start Connect GitHub again.');
    }
    return session.tenantId;
  }
  if (!linkedTenant) return null;
  if (stateParam && stateParam !== linkedTenant) {
    throw new HttpError(400, 'Invalid GitHub state. Start Connect GitHub again.');
  }
  return linkedTenant;
}

export async function recordGithubInstallation(env, input) {
  const { tenantId, installationId, accountLogin, userId } = input;
  await env.DB.prepare(
    `INSERT INTO tenant_github_installations
       (tenant_id, installation_id, account_login, account_type, updated_at)
     VALUES (?1, ?2, ?3, 'Organization', datetime('now'))
     ON CONFLICT(tenant_id, installation_id) DO UPDATE SET
       account_login = excluded.account_login,
       updated_at = datetime('now')`,
  )
    .bind(tenantId, installationId, accountLogin)
    .run();

  const linkedRepos = await linkPendingInstallationRepos(env, tenantId, installationId);
  await markStep(env, tenantId, 'github', 'COMPLETE', { installationId, linkedRepos });
  if (linkedRepos > 0) {
    await markStep(env, tenantId, 'repos', 'COMPLETE', { linkedRepos });
    await markStep(env, tenantId, 'indexing', 'PENDING');
  }
  await audit(env, tenantId, userId, 'github.connected', 'installation', String(installationId), {
    linkedRepos,
  });
  return { linkedRepos };
}

function secureCookieSuffix(request) {
  const host = new URL(request.url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  return local ? '' : '; Secure';
}

export async function tenantSummary(env, tenantId) {
  const tenant = await env.DB.prepare(
    `SELECT id, name, slack_team_id, resource_set_id, onboarding_completed_at
     FROM tenants WHERE id = ?1`,
  )
    .bind(tenantId)
    .first();
  if (!tenant) throw new HttpError(404, 'Tenant not found.');

  const slack = await env.DB.prepare(
    `SELECT team_name, bot_user_id FROM tenant_slack_installs WHERE tenant_id = ?1`,
  )
    .bind(tenantId)
    .first();
  const github = await env.DB.prepare(
    `SELECT installation_id, account_login FROM tenant_github_installations
     WHERE tenant_id = ?1 LIMIT 1`,
  )
    .bind(tenantId)
    .first();
  const { results: stepRows } = await env.DB.prepare(
    `SELECT step, status FROM tenant_onboarding_steps WHERE tenant_id = ?1`,
  )
    .bind(tenantId)
    .all();
  const steps = Object.fromEntries(STEP_KEYS.map((key) => [key, 'PENDING']));
  for (const row of stepRows) steps[row.step] = row.status;

  const repos = await listTenantRepos(env, tenantId);
  if (repos.some((repo) => repo.status === 'READY')) steps.indexing = 'COMPLETE';
  if (slack) steps.slack = 'COMPLETE';
  if (github) steps.github = 'COMPLETE';
  if (repos.length > 0) steps.repos = 'COMPLETE';
  if (tenant.onboarding_completed_at) steps.first_answer = 'COMPLETE';

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name || slack?.team_name || null,
      slackTeamId: tenant.slack_team_id,
      resourceSetId: tenant.resource_set_id,
    },
    integrations: {
      slack: Boolean(slack),
      github: Boolean(github),
    },
    steps,
    completed: Boolean(tenant.onboarding_completed_at),
    repos,
  };
}

import { syncRemoteIndexStatus } from './remoteD1.js';

export async function listTenantRepos(env, tenantId) {
  const { results } = await env.DB.prepare(
    `SELECT tr.full_name, tr.repo_id, s.status, s.indexed_files, s.total_files,
            s.total_chunks, s.error
     FROM tenant_repos tr
     LEFT JOIN repo_index_status s ON s.repo_id = tr.repo_id
     WHERE tr.tenant_id = ?1 AND tr.enabled = 1
     ORDER BY tr.full_name`,
  )
    .bind(tenantId)
    .all();
  const repos = results.map((row) => ({
    repoId: row.repo_id,
    fullName: row.full_name,
    status: row.status || 'PENDING',
    indexedFiles: row.indexed_files,
    totalFiles: row.total_files,
    totalChunks: row.total_chunks,
    error: row.error,
  }));
  try {
    return await syncRemoteIndexStatus(env, repos);
  } catch {
    return repos;
  }
}

export async function upsertRepo(env, repo) {
  const fullName = repo.fullName.trim();
  const [owner, name] = fullName.split('/');
  if (!owner || !name) throw new HttpError(400, `Invalid repo: ${fullName}`);
  const repoId = fullName.toLowerCase();
  await env.DB.prepare(
    `INSERT INTO repos (id, github_id, full_name, owner, name, default_branch, private, indexing_status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PENDING', datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       github_id = COALESCE(excluded.github_id, repos.github_id),
       full_name = excluded.full_name,
       default_branch = excluded.default_branch,
       private = excluded.private,
       updated_at = datetime('now')`,
  )
    .bind(
      repoId,
      repo.githubId || null,
      fullName,
      owner,
      name,
      repo.defaultBranch || 'main',
      repo.private === false ? 0 : 1,
    )
    .run();
  return { repoId, fullName };
}

export async function markStep(env, tenantId, step, status, metadata) {
  await env.DB.prepare(
    `INSERT INTO tenant_onboarding_steps (tenant_id, step, status, metadata_json, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(tenant_id, step) DO UPDATE SET
       status = excluded.status,
       metadata_json = COALESCE(excluded.metadata_json, tenant_onboarding_steps.metadata_json),
       updated_at = datetime('now')`,
  )
    .bind(tenantId, step, status, metadata ? JSON.stringify(metadata) : null)
    .run();
}

export async function encryptSecret(env, value) {
  if (!value) return null;
  if (!env.SLACK_TOKEN_ENCRYPTION_SECRET) {
    throw new HttpError(500, 'SLACK_TOKEN_ENCRYPTION_SECRET is not configured.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SLACK_TOKEN_ENCRYPTION_SECRET)),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value),
  );
  return `v1:${base64(iv)}:${base64(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(env, value) {
  if (!value) return null;
  if (!value.startsWith('v1:')) return value;
  if (!env.SLACK_TOKEN_ENCRYPTION_SECRET) {
    throw new HttpError(500, 'SLACK_TOKEN_ENCRYPTION_SECRET is not configured.');
  }
  const [, ivB64, dataB64] = value.split(':');
  if (!ivB64 || !dataB64) throw new HttpError(500, 'Invalid encrypted secret format.');
  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SLACK_TOKEN_ENCRYPTION_SECRET)),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64Decode(ivB64) },
    key,
    base64Decode(dataB64),
  );
  return new TextDecoder().decode(plain);
}

export async function getTenantSlackBotToken(env, tenantId) {
  const row = await env.DB.prepare(
    `SELECT bot_token_enc FROM tenant_slack_installs WHERE tenant_id = ?1`,
  )
    .bind(tenantId)
    .first();
  if (!row?.bot_token_enc) return null;
  return decryptSecret(env, row.bot_token_enc);
}

export async function audit(env, tenantId, actorUserId, eventType, targetType, targetId, metadata) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO audit_events (id, tenant_id, actor_user_id, event_type, target_type, target_id, metadata_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, tenantId, actorUserId || null, eventType, targetType || null, targetId || null, metadata ? JSON.stringify(metadata) : null)
    .run();
}

export async function handleError(err) {
  if (err instanceof HttpError) return json({ ok: false, error: err.message }, err.status);
  return json({ ok: false, error: err?.message || 'Unexpected error' }, 500);
}

export function validateOAuthState(request, expectedState) {
  const cookie = cookieValue(request.headers.get('cookie') || '', 'beacon_oauth_state');
  if (!expectedState || !cookie || cookie !== expectedState) {
    throw new HttpError(400, 'Invalid OAuth state. Start sign-in again.');
  }
}

export async function linkPendingInstallationRepos(env, tenantId, installationId) {
  const { results } = await env.DB.prepare(
    `SELECT repo_id, full_name FROM pending_installation_repos
     WHERE installation_id = ?1`,
  )
    .bind(installationId)
    .all();
  for (const row of results) {
    await env.DB.prepare(
      `INSERT INTO tenant_repos (tenant_id, repo_id, full_name, enabled, selected_by, updated_at)
       VALUES (?1, ?2, ?3, 1, 'github-installation', datetime('now'))
       ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
         enabled = 1,
         full_name = excluded.full_name,
         updated_at = datetime('now')`,
    )
      .bind(tenantId, row.repo_id, row.full_name)
      .run();
    await env.DB.prepare(
      `DELETE FROM pending_installation_repos
       WHERE installation_id = ?1 AND repo_id = ?2`,
    )
      .bind(installationId, row.repo_id)
      .run();
  }
  return results.length;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cookieValue(header, key) {
  return header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}=`))
    ?.slice(key.length + 1) || null;
}

async function hmac(secret, value) {
  if (!secret) throw new HttpError(500, 'ADMIN_SESSION_SECRET is not configured.');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64urlEncode(new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64(bytes) {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function base64Decode(value) {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function base64urlEncode(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
