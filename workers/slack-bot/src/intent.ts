/**
 * Lightweight intent routing: distinguish Q&A from agent actions (PR review).
 */

export interface PrReference {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export type UserIntent = 'qa' | 'pr_review' | 'create_pr';

const PR_URL =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/i;
const PR_SHORT = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/;

/** Extract a PR reference from free text, if present. */
export function parsePrReference(text: string): PrReference | null {
  const trimmed = text.trim();
  const urlMatch = trimmed.match(PR_URL);
  if (urlMatch) {
    const [, owner, repo, num] = urlMatch;
    return {
      owner: owner!,
      repo: repo!,
      number: Number(num),
      url: urlMatch[0],
    };
  }

  const shortMatch = trimmed.match(PR_SHORT);
  if (shortMatch) {
    const [, owner, repo, num] = shortMatch;
    return {
      owner: owner!,
      repo: repo!,
      number: Number(num),
      url: `https://github.com/${owner}/${repo}/pull/${num}`,
    };
  }

  return null;
}

const REVIEW_VERB = /\b(review|check|audit|look\s+at)\b/i;
const CREATE_PR_VERB =
  /\b(create|open|raise|make)\s+(a\s+)?(pr|pull\s+request)\b/i;
const CREATE_PR_PREFIX = /^\s*create\s+pr\s*:\s*/i;

/** Strip a leading `create pr:` prefix from issue text. */
export function stripCreatePrPrefix(text: string): string {
  return text.replace(CREATE_PR_PREFIX, '').trim();
}

export function detectIntent(text: string): UserIntent {
  if (CREATE_PR_VERB.test(text) || CREATE_PR_PREFIX.test(text)) {
    return 'create_pr';
  }

  const pr = parsePrReference(text);
  if (!pr) return 'qa';
  // Require an explicit review verb or a bare PR URL (common paste pattern).
  if (REVIEW_VERB.test(text) || PR_URL.test(text.trim())) return 'pr_review';
  return 'qa';
}
