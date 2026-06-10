/**
 * Resolve which GitHub repo to target for write actions (create PR).
 */

import type { Env } from './env.js';

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
): Promise<RepoTarget | null> {
  const { results } = await env.DB.prepare(
    `SELECT r.full_name
     FROM prototype_repo_allowlist a
     JOIN repos r ON r.id = a.repo_id
     WHERE a.enabled = 1
     ORDER BY r.full_name
     LIMIT 1`,
  ).all<{ full_name: string }>();

  const fullName = results[0]?.full_name;
  if (!fullName) return null;
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  return { owner, repo, fullName };
}

export async function resolveTargetRepo(
  env: Env,
  text: string,
): Promise<RepoTarget | null> {
  const fromText = parseRepoFromText(text);
  if (fromText) return fromText;

  const configured = env.DEFAULT_PR_REPO?.trim();
  if (configured) {
    const [owner, repo] = configured.split('/');
    if (owner && repo) {
      return { owner, repo, fullName: `${owner}/${repo}` };
    }
  }

  return getDefaultAllowlistedRepo(env);
}
