/**
 * Resolve GitHub App installation_id for a repo or tenant from control-plane D1.
 */

export interface D1Firstable {
  prepare(query: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

export async function getInstallationIdForTenant(
  db: D1Firstable,
  tenantId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT installation_id
       FROM tenant_github_installations
       WHERE tenant_id = ?1
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ installation_id: number }>();
  return row?.installation_id ?? null;
}

export async function lookupInstallationIdForRepo(
  db: D1Firstable,
  repoId: string,
): Promise<number | null> {
  const normalizedRepoId = repoId.toLowerCase();

  const pending = await db
    .prepare(
      `SELECT installation_id
       FROM pending_installation_repos
       WHERE repo_id = ?1
       LIMIT 1`,
    )
    .bind(normalizedRepoId)
    .first<{ installation_id: number }>();
  if (pending?.installation_id) return pending.installation_id;

  const tenantLinked = await db
    .prepare(
      `SELECT gi.installation_id
       FROM tenant_github_installations gi
       JOIN tenant_repos tr ON tr.tenant_id = gi.tenant_id
       WHERE tr.repo_id = ?1 AND tr.enabled = 1
       ORDER BY gi.updated_at DESC
       LIMIT 1`,
    )
    .bind(normalizedRepoId)
    .first<{ installation_id: number }>();
  return tenantLinked?.installation_id ?? null;
}
