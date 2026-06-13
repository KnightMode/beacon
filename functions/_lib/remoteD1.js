const D1_API = 'https://api.cloudflare.com/client/v4';
const DEFAULT_D1_DATABASE_ID = '27722a79-10d9-4bfc-aa53-1d65a80c8f79';

export function hasRemoteD1Config(env) {
  return Boolean(
    env.CLOUDFLARE_ACCOUNT_ID?.trim()
    && env.CLOUDFLARE_API_TOKEN?.trim(),
  );
}

export async function queryRemoteIndexStatus(env, repoIds) {
  if (!hasRemoteD1Config(env) || repoIds.length === 0) return new Map();

  const placeholders = repoIds.map((_, index) => `?${index + 1}`).join(', ');
  const sql = `SELECT repo_id, status, indexed_files, total_files, total_chunks, error
               FROM repo_index_status
               WHERE repo_id IN (${placeholders})`;
  const rows = await remoteD1Query(env, sql, repoIds);
  return new Map(rows.map((row) => [row.repo_id, row]));
}

async function remoteD1Query(env, sql, params = []) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID.trim();
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID?.trim() || DEFAULT_D1_DATABASE_ID;
  const res = await fetch(`${D1_API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Remote D1 query failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  if (!body.success) {
    const message = body.errors?.map((entry) => entry.message).join('; ') || 'unknown error';
    throw new Error(`Remote D1 query error: ${message}`);
  }
  return body.result?.[0]?.results ?? [];
}

function remoteIsAhead(local, remote) {
  const rank = { PENDING: 0, INDEXING: 1, READY: 2, FAILED: 2 };
  const localRank = rank[local.status] ?? 0;
  const remoteRank = rank[remote?.status] ?? 0;
  if (remoteRank !== localRank) return remoteRank > localRank;
  return (remote?.indexed_files ?? 0) > (local.indexedFiles ?? 0);
}

export async function syncRemoteIndexStatus(env, repos) {
  if (!hasRemoteD1Config(env) || repos.length === 0) return repos;

  const remoteByRepo = await queryRemoteIndexStatus(env, repos.map((repo) => repo.repoId));
  for (const repo of repos) {
    const remote = remoteByRepo.get(repo.repoId);
    if (!remote || !remoteIsAhead(repo, remote)) continue;

    await env.DB.prepare(
      `INSERT INTO repo_index_status
         (repo_id, status, job_type, total_files, indexed_files, total_chunks, error, updated_at)
       VALUES (?1, ?2, 'FULL_INDEX', ?3, ?4, ?5, ?6, datetime('now'))
       ON CONFLICT(repo_id) DO UPDATE SET
         status = excluded.status,
         total_files = COALESCE(excluded.total_files, repo_index_status.total_files),
         indexed_files = COALESCE(excluded.indexed_files, repo_index_status.indexed_files),
         total_chunks = COALESCE(excluded.total_chunks, repo_index_status.total_chunks),
         error = excluded.error,
         updated_at = datetime('now')`,
    )
      .bind(
        repo.repoId,
        remote.status || 'PENDING',
        remote.total_files ?? null,
        remote.indexed_files ?? null,
        remote.total_chunks ?? null,
        remote.error ?? null,
      )
      .run();

    repo.status = remote.status || repo.status;
    repo.indexedFiles = remote.indexed_files ?? repo.indexedFiles;
    repo.totalFiles = remote.total_files ?? repo.totalFiles;
    repo.totalChunks = remote.total_chunks ?? repo.totalChunks;
    repo.error = remote.error ?? repo.error;
  }

  return repos;
}
