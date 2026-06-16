#!/usr/bin/env node
/**
 * Upload generated Zoekt shard files from GitHub Actions to R2.
 *
 * The Zoekt Container mounts the same bucket/prefix read-only and serves these
 * files through zoekt-webserver.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bucket = process.env.BEACON_CODE_INTEL_BUCKET || 'beacon-code-intel';
const prefix = (process.env.BEACON_ZOEKT_R2_PREFIX || 'zoekt').replace(/^\/+|\/+$/g, '');
const indexDir = process.env.ZOEKT_INDEX_DIR;
const resultJson = process.env.INDEX_RESULT_JSON;

if (!indexDir) {
  console.log('ZOEKT_INDEX_DIR is unset; skipping Zoekt R2 sync.');
  process.exit(0);
}

async function main() {
  const root = path.resolve(indexDir);
  const repoDirs = await discoverRepoIndexDirs(root);
  if (repoDirs.length === 0) {
    console.log(`No Zoekt index files found under ${root}; skipping R2 sync.`);
    return;
  }

  let uploaded = 0;
  for (const repoDir of repoDirs) {
    uploaded += await syncRepoDir(root, repoDir);
  }
  console.log(`Uploaded ${uploaded} Zoekt index files to r2://${bucket}/${prefix}`);
}

async function syncRepoDir(root, repoDir) {
  const repoPrefix = path.basename(repoDir);
  const files = await listFiles(repoDir).catch(() => []);
  if (files.length === 0) return 0;

  const oldManifest = await readRemoteManifest(repoPrefix);
  const newKeys = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const key = prefixedKey(rel);
    runWrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', file]);
    newKeys.push(key);
  }

  await writeRemoteManifest(repoPrefix, newKeys);

  const newSet = new Set(newKeys);
  for (const key of oldManifest.keys) {
    if (!newSet.has(key)) {
      runWrangler(['r2', 'object', 'delete', `${bucket}/${key}`, '--force'], { ignoreMissing: true });
    }
  }

  return files.length;
}

async function discoverRepoIndexDirs(root) {
  const expected = await expectedRepoPrefix();
  if (expected) {
    const dir = path.join(root, expected);
    const s = await stat(dir).catch(() => null);
    return s?.isDirectory() ? [dir] : [];
  }

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

async function expectedRepoPrefix() {
  if (!resultJson) return '';
  try {
    const raw = JSON.parse(await readFile(resultJson, 'utf8'));
    const repo = typeof raw.repoFullName === 'string' ? raw.repoFullName.toLowerCase() : '';
    return repo ? zoektShardPrefix(repo) : '';
  } catch {
    return '';
  }
}

async function readRemoteManifest(repoPrefix) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'beacon-zoekt-manifest-'));
  const file = path.join(tmp, 'manifest.json');
  const key = manifestKey(repoPrefix);
  const result = runWrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--file', file], {
    ignoreMissing: true,
  });
  if (!result.ok) return { keys: [] };
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const keys = Array.isArray(parsed.keys)
      ? parsed.keys.filter((value) => typeof value === 'string')
      : [];
    return { keys };
  } catch {
    return { keys: [] };
  }
}

async function writeRemoteManifest(repoPrefix, keys) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'beacon-zoekt-manifest-'));
  const file = path.join(tmp, 'manifest.json');
  await writeFile(
    file,
    `${JSON.stringify({ version: 1, repoPrefix, keys, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  runWrangler(['r2', 'object', 'put', `${bucket}/${manifestKey(repoPrefix)}`, '--file', file]);
}

function manifestKey(repoPrefix) {
  return prefixedKey(`_manifests/${repoPrefix}.json`);
}

function prefixedKey(rel) {
  return prefix ? `${prefix}/${rel}` : rel;
}

function zoektShardPrefix(repoFullName) {
  return repoFullName.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

async function listFiles(dir) {
  const out = [];
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else if (s.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function runWrangler(args, options = {}) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.ignoreMissing ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (options.ignoreMissing && /not found|does not exist|NoSuchKey/i.test(combined)) {
      return { ok: false };
    }
    throw new Error(`wrangler ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return { ok: true };
}

main().catch((err) => {
  process.stderr.write(`sync-zoekt-index-to-r2 failed: ${err.message}\n`);
  process.exit(1);
});
