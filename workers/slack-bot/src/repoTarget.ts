/**
 * Resolve which GitHub repo to target for write actions (create PR).
 */

import type { Env } from './env.js';
import { parseRepoRef, repoIdFor } from '@scintel/shared';
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
    return repoTargetFromFullName(`${owner}/${repo}`);
  }
  const shortMatch = text.match(REPO_SHORT);
  if (shortMatch) {
    const [, owner, repo] = shortMatch;
    return repoTargetFromFullName(`${owner}/${repo}`);
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
  return repoTargetFromFullName(fullName);
}

/** Match natural-language repo aliases against allowlisted repo slug parts. */
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
    const repo = parseRepoRef(fullName);
    if (!repo) continue;
    const slug = repo.name.toLowerCase();
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
  return repoTargetFromFullName(best.fullName);
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
  const access = await getTenantRepoAccess(env, teamId);
  if (teamId && !access) return null;

  const fromText = parseRepoFromText(text);
  if (fromText) {
    if (!access) return fromText;
    return access.repoIds.includes(repoIdFor(fromText.fullName)) ? fromText : null;
  }

  const fuzzy = await fuzzyMatchAllowlistedRepo(env, text, teamId);
  if (fuzzy) return fuzzy;

  const configured = env.DEFAULT_PR_REPO?.trim();
  if (configured && (!access || access.repoIds.includes(repoIdFor(configured)))) {
    return repoTargetFromFullName(configured);
  }

  return getDefaultAllowlistedRepo(env, teamId);
}

function repoTargetFromFullName(fullName: string): RepoTarget | null {
  const parsed = parseRepoRef(fullName);
  return parsed
    ? { owner: parsed.owner, repo: parsed.name, fullName: parsed.fullName }
    : null;
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
  if (teamId) return [];

  const { results } = await env.DB.prepare(
    `SELECT r.full_name
     FROM prototype_repo_allowlist a
     JOIN repos r ON r.id = a.repo_id
     WHERE a.enabled = 1
     ORDER BY r.full_name`,
  ).all<{ full_name: string }>();
  return results;
}
