/**
 * Resolve which GitHub repo to target for write actions (create PR).
 */

import type { Env } from './env.js';
import { getTenantRepoAccess } from './tenant.js';

export interface RepoTarget {
  owner: string;
  repo: string;
  fullName: string;
}

const REPO_GH_URL =
  /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;
/** owner/repo not followed by #123 (PR shorthand). */
const REPO_SHORT = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?!#\d)\b/;

export function parseRepoFromText(text: string): RepoTarget | null {
  const urlMatch = text.match(REPO_GH_URL);
  if (urlMatch) {
    const [, owner, repo] = urlMatch;
    return { owner: owner!, repo: repo!, fullName: `${owner}/${repo}` };
  }
  const shortMatch = text.match(REPO_SHORT);
  if (shortMatch) {
    const [, owner, repo] = shortMatch;
    return { owner: owner!, repo: repo!, fullName: `${owner}/${repo}` };
  }
  return null;
}

export async function getDefaultAllowlistedRepo(
  env: Env,
  teamId?: string,
): Promise<RepoTarget | null> {
  const results = await listAccessibleRepos(env, teamId);

  const fullName = results[0]?.full_name;
  if (!fullName) return null;
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  return { owner, repo, fullName };
}

/** Match phrases like "ebpf router repo" to allowlisted KnightMode/ebpf-wiremock-router. */
export async function fuzzyMatchAllowlistedRepo(
  env: Env,
  text: string,
  teamId?: string,
): Promise<RepoTarget | null> {
  const results = await listAccessibleRepos(env, teamId);

  const lower = text.toLowerCase();
  const words =
    lower.match(/\b[a-z][a-z0-9-]{2,}\b/g)?.filter((w) => !REPO_STOPWORDS.has(w)) ??
    [];

  let best: { fullName: string; score: number } | null = null;
  for (const row of results) {
    const fullName = row.full_name;
    const slug = (fullName.split('/')[1] ?? '').toLowerCase();
    if (!slug) continue;
    const parts = slug.split('-').filter((p) => p.length > 2);

    let score = 0;
    if (lower.includes(slug) || lower.includes(slug.replace(/-/g, ' '))) {
      score += 10;
    }
    for (const part of parts) {
      if (words.some((w) => w === part || w.includes(part) || part.includes(w))) {
        score += 3;
      }
    }

    if (!best || score > best.score) {
      best = { fullName, score };
    }
  }

  if (!best || best.score < 3) return null;
  const [owner, repo] = best.fullName.split('/');
  if (!owner || !repo) return null;
  return { owner, repo, fullName: best.fullName };
}

const REPO_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'add',
  'create',
  'pr',
  'repo',
  'repository',
  'docs',
  'doc',
  'explain',
  'explaining',
  'implementation',
  'eli5',
]);

export async function resolveTargetRepo(
  env: Env,
  text: string,
  teamId?: string,
): Promise<RepoTarget | null> {
  const fromText = parseRepoFromText(text);
  if (fromText) {
    const access = await getTenantRepoAccess(env, teamId);
    if (!access) return fromText;
    return access.repoIds.includes(fromText.fullName.toLowerCase()) ? fromText : null;
  }

  const fuzzy = await fuzzyMatchAllowlistedRepo(env, text, teamId);
  if (fuzzy) return fuzzy;

  const access = await getTenantRepoAccess(env, teamId);
  const configured = env.DEFAULT_PR_REPO?.trim();
  if (configured && (!access || access.repoIds.includes(configured.toLowerCase()))) {
    const [owner, repo] = configured.split('/');
    if (owner && repo) {
      return { owner, repo, fullName: `${owner}/${repo}` };
    }
  }

  return getDefaultAllowlistedRepo(env, teamId);
}

async function listAccessibleRepos(
  env: Env,
  teamId?: string,
): Promise<Array<{ full_name: string }>> {
  const access = await getTenantRepoAccess(env, teamId);
  if (access) {
    if (access.repoIds.length === 0) return [];
    const placeholders = access.repoIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT full_name FROM repos
       WHERE id IN (${placeholders})
       ORDER BY full_name`,
    )
      .bind(...access.repoIds)
      .all<{ full_name: string }>();
    return results;
  }

  const { results } = await env.DB.prepare(
    `SELECT r.full_name
     FROM prototype_repo_allowlist a
     JOIN repos r ON r.id = a.repo_id
     WHERE a.enabled = 1
     ORDER BY r.full_name`,
  ).all<{ full_name: string }>();
  return results;
}
