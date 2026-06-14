import { parseRepoRef } from './repoRef.js';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export interface RepositoryDispatchInput {
  repository: string;
  token: string;
  eventType: string;
  clientPayload: Record<string, unknown>;
  userAgent: string;
}

export interface RepositoryDispatchResult {
  ok: boolean;
  status: number;
  body: string;
}

export function githubJsonHeaders(
  token: string,
  userAgent: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': userAgent,
    'x-github-api-version': GITHUB_API_VERSION,
  };
}

export async function createRepositoryDispatch(
  input: RepositoryDispatchInput,
): Promise<RepositoryDispatchResult> {
  const res = await fetch(`${GITHUB_API}/repos/${repoPath(input.repository)}/dispatches`, {
    method: 'POST',
    headers: githubJsonHeaders(input.token, input.userAgent),
    body: JSON.stringify({
      event_type: input.eventType,
      client_payload: input.clientPayload,
    }),
  });

  return {
    ok: res.ok,
    status: res.status,
    body: res.ok ? '' : await res.text().catch(() => ''),
  };
}

function repoPath(repository: string): string {
  const repo = parseRepoRef(repository);
  if (!repo) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
