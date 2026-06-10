/**
 * Minimal GitHub REST client (fetch-based) for the single indexing identity.
 * Uses a fine-grained PAT by default. GitHub App auth is stubbed: if app
 * credentials are provided we still fall back to the PAT for the prototype.
 */

import type { IndexerConfig } from './config.js';
import { log } from './logger.js';

const API = 'https://api.github.com';

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export class GitHubClient {
  private readonly token: string;

  constructor(config: IndexerConfig) {
    if (config.github.appId) {
      // GitHub App support is stubbed for the prototype.
      log.warn('GitHub App credentials present but App auth is stubbed; using PAT');
    }
    this.token = config.github.pat;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'scintel-indexer',
    };
  }

  async getRepo(
    owner: string,
    name: string,
  ): Promise<{ default_branch: string; private: boolean; id: number }> {
    const res = await fetch(`${API}/repos/${owner}/${name}`, {
      headers: this.headers(),
    });
    await assertOk(res, `getRepo ${owner}/${name}`);
    const body = (await res.json()) as {
      default_branch: string;
      private: boolean;
      id: number;
    };
    return body;
  }

  async getBranchHeadSha(
    owner: string,
    name: string,
    branch: string,
  ): Promise<string> {
    const res = await fetch(
      `${API}/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`,
      { headers: this.headers() },
    );
    await assertOk(res, `getBranch ${owner}/${name}@${branch}`);
    const body = (await res.json()) as { commit: { sha: string } };
    return body.commit.sha;
  }

  /** Recursive git tree at a commit sha. */
  async getTree(
    owner: string,
    name: string,
    commitSha: string,
  ): Promise<TreeEntry[]> {
    const res = await fetch(
      `${API}/repos/${owner}/${name}/git/trees/${commitSha}?recursive=1`,
      { headers: this.headers() },
    );
    await assertOk(res, `getTree ${owner}/${name}@${commitSha}`);
    const body = (await res.json()) as {
      tree: TreeEntry[];
      truncated: boolean;
    };
    if (body.truncated) {
      log.warn('git tree truncated; some files will be skipped', {
        repo: `${owner}/${name}`,
      });
    }
    return body.tree.filter((e) => e.type === 'blob');
  }

  /**
   * Changed/removed files between two commits via the compare API. Returns
   * null when the diff can't be trusted as complete: unknown base (force
   * push / GC'd sha) or a result at the API's 300-file cap.
   */
  async compareCommits(
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<{ changed: string[]; removed: string[] } | null> {
    const res = await fetch(
      `${API}/repos/${owner}/${name}/compare/${base}...${head}`,
      { headers: this.headers() },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      files?: Array<{
        filename: string;
        status: string;
        previous_filename?: string;
      }>;
    };
    const files = body.files ?? [];
    if (files.length >= 300) return null; // compare API caps at 300 files
    const changed: string[] = [];
    const removed: string[] = [];
    for (const f of files) {
      if (f.status === 'removed') {
        removed.push(f.filename);
      } else {
        if (f.status === 'renamed' && f.previous_filename) {
          removed.push(f.previous_filename);
        }
        changed.push(f.filename);
      }
    }
    return { changed, removed };
  }

  /** UTF-8 contents of a blob by its sha. Returns null for binary/oversized. */
  async getBlobContent(
    owner: string,
    name: string,
    blobSha: string,
  ): Promise<string | null> {
    const res = await fetch(
      `${API}/repos/${owner}/${name}/git/blobs/${blobSha}`,
      { headers: this.headers() },
    );
    await assertOk(res, `getBlob ${owner}/${name}/${blobSha}`);
    const body = (await res.json()) as {
      content: string;
      encoding: string;
    };
    if (body.encoding !== 'base64') return null;
    try {
      return Buffer.from(body.content, 'base64').toString('utf-8');
    } catch {
      return null;
    }
  }
}

async function assertOk(res: Response, ctx: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${ctx} failed: ${res.status} ${text.slice(0, 300)}`);
  }
}
