/**
 * Minimal GitHub REST client (fetch-based) for indexing.
 * Reads repo contents with a GitHub App installation token (preferred) or PAT.
 */

import { gunzipSync } from 'node:zlib';

const API = 'https://api.github.com';

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export class GitHubClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'scintel-indexer',
    };
  }

  /**
   * GET with retries on transient failures (5xx, 429, network errors). A
   * single GitHub hiccup must not kill a whole indexing run that makes
   * hundreds of API calls.
   */
  private async request(url: string, attempts = 3): Promise<Response> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url, { headers: this.headers() });
        if (res.status < 500 && res.status !== 429) return res;
        lastErr = new Error(`status ${res.status}`);
      } catch (err) {
        lastErr = err as Error;
      }
      if (attempt < attempts) {
        const delay = 500 * attempt * attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error(`GitHub request failed after ${attempts} attempts: ${url} (${lastErr?.message})`);
  }

  async getRepo(
    owner: string,
    name: string,
  ): Promise<{ default_branch: string; private: boolean; id: number }> {
    const res = await this.request(`${API}/repos/${owner}/${name}`);
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
    const res = await this.request(
      `${API}/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`,
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
    const res = await this.request(
      `${API}/repos/${owner}/${name}/git/trees/${commitSha}?recursive=1`,
    );
    await assertOk(res, `getTree ${owner}/${name}@${commitSha}`);
    const body = (await res.json()) as {
      tree: TreeEntry[];
      truncated: boolean;
    };
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
    const res = await this.request(
      `${API}/repos/${owner}/${name}/compare/${base}...${head}`,
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
    if (files.length >= 300) return null;
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
    const res = await this.request(
      `${API}/repos/${owner}/${name}/git/blobs/${blobSha}`,
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

  /**
   * Download the repo tarball at a ref once and return repo-relative path → UTF-8
   * content. Replaces one git/blobs call per indexed file.
   */
  async downloadTarball(
    owner: string,
    name: string,
    ref: string,
  ): Promise<Map<string, string>> {
    const res = await this.request(
      `${API}/repos/${owner}/${name}/tarball/${encodeURIComponent(ref)}`,
    );
    await assertOk(res, `tarball ${owner}/${name}@${ref}`);
    const gz = Buffer.from(await res.arrayBuffer());
    const tar = gunzipSync(gz);
    return parseTarToPathMap(tar);
  }
}

function parseTarToPathMap(tar: Buffer): Map<string, string> {
  const raw = parseTarEntries(tar);
  const files = new Map<string, string>();
  for (const [fullPath, content] of raw) {
    const slash = fullPath.indexOf('/');
    if (slash < 0) continue;
    const rel = fullPath.slice(slash + 1);
    if (!rel) continue;
    files.set(rel, content.toString('utf-8'));
  }
  return files;
}

function parseTarEntries(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let pendingPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(readTarString(header, 124, 12), 8) || 0;
    const type = header[156] ?? 0;

    offset += 512;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === 120) {
      pendingPath = parsePaxPath(data) ?? pendingPath;
      continue;
    }
    if (type === 76) {
      pendingPath = data.toString('utf-8').replace(/\0+$/, '') || pendingPath;
      continue;
    }
    if (type === 0 || type === 48) {
      files.set(pendingPath ?? fullName, data);
    }
    pendingPath = null;
  }
  return files;
}

function parsePaxPath(data: Buffer): string | null {
  const text = data.toString('utf-8');
  let pos = 0;
  while (pos < text.length) {
    const space = text.indexOf(' ', pos);
    if (space < 0) break;
    const len = parseInt(text.slice(pos, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, pos + len);
    const eq = record.indexOf('=');
    if (eq >= 0 && record.slice(0, eq) === 'path') {
      return record.slice(eq + 1).replace(/\n$/, '');
    }
    pos += len;
  }
  return null;
}

function readTarString(buf: Buffer, start: number, len: number): string {
  const end = start + len;
  let out = '';
  for (let i = start; i < end; i++) {
    const b = buf[i] ?? 0;
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
}

async function assertOk(res: Response, ctx: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint = res.status === 404
      ? ' (repo missing or GitHub App installation lacks access)'
      : '';
    throw new Error(`GitHub ${ctx} failed: ${res.status} ${text.slice(0, 300)}${hint}`);
  }
}
