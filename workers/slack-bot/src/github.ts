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

export interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps: Array<{ name: string; conclusion: string | null; number: number }>;
}

export interface CommitDiff {
  message: string;
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
  }>;
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

  /**
   * fetch with retries on transient GitHub failures: 5xx/429/network errors,
   * plus spurious 401s (observed in production: a create-PR call got 401
   * "Requires authentication" once and succeeded on retry with the same
   * token). A 401 means the request was rejected before acting, so retrying
   * non-idempotent calls is safe. Real auth errors just fail a little slower.
   */
  private async request(url: string, init?: RequestInit): Promise<Response> {
    const attempts = 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url, init);
        const retryable =
          res.status >= 500 ||
          res.status === 429 ||
          (res.status === 401 && attempt === 1);
        if (!retryable) return res;
        lastErr = new Error(`status ${res.status}`);
      } catch (err) {
        lastErr = err as Error;
      }
      if (attempt < attempts) {
        console.warn('GitHub request failed; retrying', {
          url,
          attempt,
          error: lastErr?.message,
        });
        await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
      }
    }
    throw new Error(
      `GitHub request failed after ${attempts} attempts: ${url} (${lastErr?.message})`,
    );
  }

  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PullRequest> {
    const res = await this.request(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
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
    const res = await this.request(
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
    const repoRes = await this.request(`${API}/repos/${owner}/${repo}`, {
      headers: this.headers(),
    });
    await assertOk(repoRes, `getRepo ${owner}/${repo}`);
    const repoBody = (await repoRes.json()) as { default_branch: string };
    const branch = repoBody.default_branch;

    const refRes = await this.request(
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
    const res = await this.request(`${API}/repos/${owner}/${repo}/git/refs`, {
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

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    const res = await this.request(
      `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      { headers: this.headers() },
    );
    if (res.status === 404) return null;
    await assertOk(res, `getFileContent ${owner}/${repo}/${path}`);
    const body = (await res.json()) as { content?: string; encoding?: string };
    if (body.encoding !== 'base64' || !body.content) return null;
    try {
      const binary = atob(body.content.replace(/\n/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  async getFileSha(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    const res = await this.request(
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

    const res = await this.request(
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
    const res = await this.request(`${API}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, head, base }),
    });
    await assertOk(res, `createPullRequest ${owner}/${repo}`);
    const pr = (await res.json()) as { number: number; html_url: string };
    return { number: pr.number, htmlUrl: pr.html_url };
  }

  async getWorkflowRunJobs(
    owner: string,
    repo: string,
    runId: number,
    runAttempt?: number,
  ): Promise<WorkflowJob[]> {
    const url = runAttempt
      ? `${API}/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`
      : `${API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`;
    const res = await this.request(url, { headers: this.headers() });
    await assertOk(res, `getWorkflowRunJobs ${owner}/${repo} run ${runId}`);
    const body = (await res.json()) as {
      jobs?: Array<{
        id: number;
        name: string;
        conclusion: string | null;
        steps?: Array<{ name: string; conclusion: string | null; number: number }>;
      }>;
    };
    return (body.jobs ?? []).map((j) => ({
      id: j.id,
      name: j.name,
      conclusion: j.conclusion,
      steps: (j.steps ?? []).map((s) => ({
        name: s.name,
        conclusion: s.conclusion,
        number: s.number,
      })),
    }));
  }

  /**
   * Job logs as plain text. The endpoint 302-redirects to a signed blob URL;
   * we must NOT follow it with the default fetch, which re-sends the
   * Authorization header — the blob store rejects requests carrying both a
   * SAS token and an Authorization header. Manual redirect, then a bare
   * fetch with no auth.
   */
  async getJobLogs(
    owner: string,
    repo: string,
    jobId: number,
    maxBytes = 2_000_000,
  ): Promise<string> {
    const res = await this.request(
      `${API}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      { headers: this.headers(), redirect: 'manual' },
    );
    let logRes = res;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`getJobLogs ${owner}/${repo} job ${jobId}: redirect without location`);
      }
      logRes = await fetch(location, {
        headers: { 'user-agent': 'scintel-slack-bot' },
      });
    }
    await assertOk(logRes, `getJobLogs ${owner}/${repo} job ${jobId}`);
    const text = await logRes.text();
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
  }

  async getCommitDiff(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<CommitDiff> {
    const res = await this.request(
      `${API}/repos/${owner}/${repo}/commits/${sha}`,
      { headers: this.headers() },
    );
    await assertOk(res, `getCommitDiff ${owner}/${repo}@${sha}`);
    const body = (await res.json()) as {
      commit?: { message?: string };
      files?: Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }>;
    };
    return {
      message: body.commit?.message ?? '',
      files: (body.files ?? []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      })),
    };
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
