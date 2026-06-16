#!/usr/bin/env node
/**
 * Idempotent provisioning for Beacon code-intel storage.
 *
 * Creates the R2 bucket used to hold Zoekt shard files. D1 schema provisioning
 * remains in apply-admin-d1-migrations.mjs.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bucket = process.env.BEACON_CODE_INTEL_BUCKET || 'beacon-code-intel';
const prefix = (process.env.BEACON_ZOEKT_R2_PREFIX || 'zoekt').replace(/^\/+|\/+$/g, '');

async function main() {
  console.log(`Provisioning code-intel R2 bucket: ${bucket}`);
  const result = spawnSync('npx', ['wrangler', 'r2', 'bucket', 'create', bucket], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0) {
    process.stdout.write(result.stdout || '');
    console.log('Code-intel R2 bucket ready.');
  } else if (/already exists|bucket.*exists|name.*taken/i.test(combined)) {
    console.log('Code-intel R2 bucket already exists; continuing.');
  } else {
    process.stderr.write(combined);
    throw new Error(`wrangler r2 bucket create failed with exit code ${result.status}`);
  }

  await putPrefixMarker();
}

async function putPrefixMarker() {
  const dir = await mkdtemp(path.join(tmpdir(), 'beacon-code-intel-'));
  const marker = path.join(dir, '.keep');
  await writeFile(marker, `created=${new Date().toISOString()}\n`, 'utf8');
  const key = prefix ? `${prefix}/.keep` : '.keep';
  const result = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', marker], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`wrangler r2 object put ${bucket}/${key} failed with exit code ${result.status}`);
  }
  console.log(`Code-intel R2 prefix ready: r2://${bucket}/${prefix || '.'}`);
}

main().catch((err) => {
  process.stderr.write(`provision-code-intel failed: ${err.message}\n`);
  process.exit(1);
});
