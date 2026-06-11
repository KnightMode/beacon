/**
 * Offline dataset linter: `npm run validate --workspace packages/eval`.
 * Validates golden/beacon.json (or --dataset <path>) without any network.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from './validate.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf('--dataset');
  const dataset = resolve(
    PKG_ROOT,
    flagIdx >= 0 ? argv[flagIdx + 1]! : 'golden/beacon.json',
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(dataset, 'utf8'));
  } catch (err) {
    console.error(`Could not read/parse ${dataset}: ${(err as Error).message}`);
    process.exit(2);
  }

  const issues = validateDataset(parsed);
  if (issues.length > 0) {
    console.error(`${dataset}: ${issues.length} problem(s):`);
    for (const issue of issues) console.error(`  - ${issue.caseId}: ${issue.problem}`);
    process.exit(1);
  }
  const count = Array.isArray(parsed) ? parsed.length : 0;
  console.log(`${dataset}: ok (${count} cases).`);
}

main();
