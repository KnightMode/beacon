/**
 * GitHub REST client for agent actions: PR review (read) and create PR (write).
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

export interface CreatedPullRequest {
  number: number;
  htmlUrl: string;
}

export interface FileChange {
  path: string;
  content: string;
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

  async getDefaultBranchSha(
    owner: string,
    repo: string,
  ): Promise<{ defaultBranch: string; sha: string }> {
    const repoRes = await fetch(`${API}/repos/${owner}/${repo}`, {
      headers: this.headers(),
    });
    await assertOk(repoRes, `getRepo ${owner}/${repo}`);
    const repoBody = (await repoRes.json()) as { default_branch: string };
    const branch = repoBody.default_branch;

    const refRes = await fetch(
      `${API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { headers: this.headers() },
    );
    await assertOk(refRes, `getRef ${owner}/${repo}@${branch}`);
    const refBody = (await refRes.json()) as { object: { sha: string } };
    return { defaultBranch: branch, sha: refBody.object.sha };
  }

  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    fromSha: string,
  ): Promise<void> {
    const res = await fetch(`${API}/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
    });
    if (res.status === 422) {
      // Branch already exists — reuse it for subsequent file commits.
      return;
    }
    await assertOk(res, `createBranch ${owner}/${repo}@${branch}`);
  }

  async getFileSha(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      { headers: this.headers() },
    );
    if (res.status === 404) return null;
    await assertOk(res, `getFileSha ${owner}/${repo}/${path}`);
    const body = (await res.json()) as { sha?: string };
    return body.sha ?? null;
  }

  async upsertFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string,
  ): Promise<void> {
    const existingSha = await this.getFileSha(owner, repo, path, branch);
    const body: Record<string, string> = {
      message,
      content: encodeBase64(content),
      branch,
    };
    if (existingSha) body.sha = existingSha;

    const res = await fetch(
      `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
      {
        method: 'PUT',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    await assertOk(res, `upsertFile ${owner}/${repo}/${path}`);
  }

  async createPullRequest(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<CreatedPullRequest> {
    const res = await fetch(`${API}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, head, base }),
    });
    await assertOk(res, `createPullRequest ${owner}/${repo}`);
    const pr = (await res.json()) as { number: number; html_url: string };
    return { number: pr.number, htmlUrl: pr.html_url };
  }

  /** Create branch, commit files, and open a PR against the default branch. */
  async createPullRequestFromChanges(
    owner: string,
    repo: string,
    branch: string,
    title: string,
    body: string,
    files: FileChange[],
  ): Promise<CreatedPullRequest> {
    const { defaultBranch, sha } = await this.getDefaultBranchSha(owner, repo);
    await this.createBranch(owner, repo, branch, sha);

    for (const file of files) {
      await this.upsertFile(
        owner,
        repo,
        file.path,
        file.content,
        branch,
        `${title} (${file.path})`,
      );
    }

    return this.createPullRequest(owner, repo, title, body, branch, defaultBranch);
  }
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function assertOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  throw new Error(`${label}: GitHub API ${res.status} ${text.slice(0, 400)}`);
}
