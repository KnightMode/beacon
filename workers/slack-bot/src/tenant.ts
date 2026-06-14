import type { Env } from './env.js';

const TOKEN_PREFIX = 'v1:';
const CACHE_TTL_MS = 45_000;

let cachedTokens = new Map<string, { token: string; expiresAt: number }>();
let cachedRepos = new Map<string, { ids: string[]; expiresAt: number }>();

export async function getTenantIdForSlackTeam(
  env: Env,
  teamId?: string,
): Promise<string | null> {
  if (!teamId) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM tenants WHERE slack_team_id = ?1 AND status = 'ACTIVE'`,
  )
    .bind(teamId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function getTenantRepoIds(
  env: Env,
  teamId?: string,
): Promise<string[]> {
  const access = await getTenantRepoAccess(env, teamId);
  return access?.repoIds ?? [];
}

export async function getTenantRepoAccess(
  env: Env,
  teamId?: string,
): Promise<{ tenantId: string; repoIds: string[] } | null> {
  const tenantId = await getTenantIdForSlackTeam(env, teamId);
  if (!tenantId) return null;

  const now = Date.now();
  const cached = cachedRepos.get(tenantId);
  if (cached && cached.expiresAt > now) {
    return { tenantId, repoIds: cached.ids };
  }

  const { results } = await env.DB.prepare(
    `SELECT repo_id FROM tenant_repos
     WHERE tenant_id = ?1 AND enabled = 1
     ORDER BY full_name`,
  )
    .bind(tenantId)
    .all<{ repo_id: string }>();

  const ids = results.map((r) => r.repo_id);
  cachedRepos.set(tenantId, { ids, expiresAt: now + CACHE_TTL_MS });
  return { tenantId, repoIds: ids };
}

export async function tenantHasGithubInstallationRepo(
  env: Env,
  tenantId: string,
  repoId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok
     FROM tenant_github_installations gi
     JOIN github_installation_repos p ON p.installation_id = gi.installation_id
     WHERE gi.tenant_id = ?1 AND p.repo_id = ?2
     UNION ALL
     SELECT 1 AS ok
     FROM tenant_github_installations gi
     JOIN pending_installation_repos p ON p.installation_id = gi.installation_id
     WHERE gi.tenant_id = ?1 AND p.repo_id = ?2
     UNION ALL
     SELECT 1 AS ok
     FROM tenant_repos tr
     WHERE tr.tenant_id = ?1 AND tr.repo_id = ?2 AND tr.enabled = 1
     LIMIT 1`,
  )
    .bind(tenantId, repoId)
    .first<{ ok: number }>();
  return row !== null;
}

export async function getTenantRepoGrant(
  env: Env,
  tenantId: string,
  repoId: string,
): Promise<{ repoId: string; fullName: string; installationId: number } | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(gir.full_name, tr.full_name) AS full_name,
            COALESCE(tr.installation_id, gir.installation_id) AS installation_id
     FROM tenant_repos tr
     LEFT JOIN github_installation_repos gir
       ON gir.installation_id = tr.installation_id AND gir.repo_id = tr.repo_id
     WHERE tr.tenant_id = ?1 AND tr.repo_id = ?2 AND tr.enabled = 1
     UNION ALL
     SELECT gir.full_name, gir.installation_id
     FROM tenant_github_installations gi
     JOIN github_installation_repos gir ON gir.installation_id = gi.installation_id
     WHERE gi.tenant_id = ?1 AND gir.repo_id = ?2
     LIMIT 1`,
  )
    .bind(tenantId, repoId)
    .first<{ full_name: string; installation_id: number | null }>();
  if (!row?.full_name || !row.installation_id) return null;
  return { repoId, fullName: row.full_name, installationId: row.installation_id };
}

export async function getTenantRepoGrantForSlackTeam(
  env: Env,
  teamId: string | undefined,
  repoFullName: string,
): Promise<{ tenantId: string; repoId: string; fullName: string; installationId: number } | null> {
  const tenantId = await getTenantIdForSlackTeam(env, teamId);
  if (!tenantId) return null;
  const repoId = repoFullName.toLowerCase();
  const grant = await getTenantRepoGrant(env, tenantId, repoId);
  return grant ? { tenantId, ...grant } : null;
}

export async function getSlackBotToken(
  env: Env,
  teamId?: string,
): Promise<string> {
  if (!teamId) return env.SLACK_BOT_TOKEN;

  const now = Date.now();
  const cached = cachedTokens.get(teamId);
  if (cached && cached.expiresAt > now) return cached.token;

  const row = await env.DB.prepare(
    `SELECT bot_token_enc FROM tenant_slack_installs
     WHERE slack_team_id = ?1`,
  )
    .bind(teamId)
    .first<{ bot_token_enc: string | null }>();

  if (!row?.bot_token_enc) return env.SLACK_BOT_TOKEN;
  const token = await decryptToken(env, row.bot_token_enc);
  cachedTokens.set(teamId, { token, expiresAt: now + CACHE_TTL_MS });
  return token;
}

/** Slack team id for a tenant-scoped repo (used by CI triage). */
export async function getSlackTeamIdForRepo(
  env: Env,
  repoId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT t.slack_team_id
     FROM tenants t
     JOIN tenant_repos tr ON tr.tenant_id = t.id
     WHERE tr.repo_id = ?1 AND tr.enabled = 1 AND t.status = 'ACTIVE'
     LIMIT 1`,
  )
    .bind(repoId)
    .first<{ slack_team_id: string }>();
  return row?.slack_team_id ?? null;
}

/** Marks onboarding step 6 when a tenant gets its first cited answer. */
export async function markFirstCitedAnswer(
  env: Env,
  teamId?: string,
): Promise<void> {
  if (!teamId) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tenants
       SET onboarding_completed_at = COALESCE(onboarding_completed_at, datetime('now')),
           updated_at = datetime('now')
       WHERE slack_team_id = ?1`,
    ).bind(teamId),
    env.DB.prepare(
      `INSERT INTO tenant_onboarding_steps (tenant_id, step, status, updated_at)
       SELECT id, 'first_answer', 'COMPLETE', datetime('now')
       FROM tenants
       WHERE slack_team_id = ?1
       ON CONFLICT(tenant_id, step) DO UPDATE SET
         status = 'COMPLETE',
         updated_at = datetime('now')`,
    ).bind(teamId),
  ]);
}

export async function decryptToken(env: Env, value: string): Promise<string> {
  if (!value.startsWith(TOKEN_PREFIX)) return value;
  if (!env.SLACK_TOKEN_ENCRYPTION_SECRET) {
    throw new Error('SLACK_TOKEN_ENCRYPTION_SECRET is required for tenant Slack tokens');
  }

  const [, ivB64, dataB64] = value.split(':');
  if (!ivB64 || !dataB64) throw new Error('invalid encrypted Slack token');

  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(env.SLACK_TOKEN_ENCRYPTION_SECRET),
    ),
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivB64) },
    key,
    fromBase64(dataB64),
  );
  return new TextDecoder().decode(plain);
}

function fromBase64(value: string): ArrayBuffer {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
