/**
 * Minimal GitHub REST client for agent actions (PR review). Read-only for
 * Phase 1; uses the same fine-grained PAT as the indexer.
 */

import type { Env } from './env.js';

const API = 'https://api.github.com';

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  state: string;
  headRef: string;
  baseRef: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export class GitHubClient {
  constructor(private readonly token: string) {}

  static fromEnv(env: Env): GitHubClient | null {
    const token = env.GITHUB_PAT?.trim();
    return token ? new GitHubClient(token) : null;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'scintel-slack-bot',
    };
  }

  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequest> {
    const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
      headers: this.headers(),
    });
    await assertOk(res, `getPullRequest ${owner}/${repo}#${number}`);
    const body = (await res.json()) as {
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
      changed_files: number;
      additions: number;
      deletions: number;
    };
    return {
      number: body.number,
      title: body.title,
      body: body.body,
      htmlUrl: body.html_url,
      state: body.state,
      headRef: body.head.ref,
      baseRef: body.base.ref,
      changedFiles: body.changed_files,
      additions: body.additions,
      deletions: body.deletions,
    };
  }

  async listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequestFile[]> {
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
      { headers: this.headers() },
    );
    await assertOk(res, `listPullRequestFiles ${owner}/${repo}#${number}`);
    const body = (await res.json()) as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch: string | null;
    }>;
    return body.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
  }
}

async function assertOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  throw new Error(`${label}: GitHub API ${res.status} ${text.slice(0, 400)}`);
}
