#!/usr/bin/env node
/**
 * Convert a downloaded GitHub App .pem file into a single .dev.vars line.
 *
 * Usage:
 *   node scripts/format-github-private-key.mjs ~/Downloads/scintel-indexer.*.private-key.pem
 */

import { readFileSync } from 'node:fs';

const pemPath = process.argv[2];
if (!pemPath) {
  console.error('Usage: node scripts/format-github-private-key.mjs <path-to-private-key.pem>');
  process.exit(1);
}

const pem = readFileSync(pemPath, 'utf8').trim();
const oneLine = pem.replace(/\r?\n/g, '\\n');
console.log(`GITHUB_APP_PRIVATE_KEY="${oneLine}"`);
