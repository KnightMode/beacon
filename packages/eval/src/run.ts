/**
 * Eval runner CLI.
 *
 * Usage:
 *   npm run eval --workspace packages/eval -- \
 *     --endpoint https://scintel-slack-bot.<acct>.workers.dev --token $EVAL_TOKEN
 *
 * Flags (env fallbacks in parens):
 *   --dataset <path>      golden dataset JSON (default golden/beacon.json)
 *   --endpoint <url>      worker base URL (EVAL_ENDPOINT)
 *   --token <token>       bearer token for /eval/ask (EVAL_TOKEN)
 *   --agentic <bool>      use agentic retrieval (default true)
 *   --concurrency <n>     parallel questions (default 2)
 *   --fail-under <score>  exit 1 if composite mean is below this (default 0)
 *   --update-baseline     copy this run's report to results/baseline.json
 *
 * Writes results/latest.json (+ timestamped copy) and prints a per-case table
 * with the composite mean and the delta vs results/baseline.json when present.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askEval } from './client.js';
import { scoreCase } from './score.js';
import { validateDataset } from './validate.js';
import type { CaseResult, EvalReport, GoldenCase } from './types.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(PKG_ROOT, 'results');

interface CliOptions {
  dataset: string;
  endpoint: string;
  token: string;
  agentic: boolean;
  concurrency: number;
  failUnder: number;
  updateBaseline: boolean;
  skipPreflight: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const endpoint = get('--endpoint') ?? process.env.EVAL_ENDPOINT;
  const token = get('--token') ?? process.env.EVAL_TOKEN;
  if (!endpoint || !token) {
    console.error(
      'Missing --endpoint/--token (or EVAL_ENDPOINT/EVAL_TOKEN env vars).',
    );
    process.exit(2);
  }
  return {
    dataset: resolve(PKG_ROOT, get('--dataset') ?? 'golden/beacon.json'),
    endpoint,
    token,
    agentic: get('--agentic') !== 'false',
    concurrency: Number(get('--concurrency') ?? 2),
    failUnder: Number(get('--fail-under') ?? 0),
    updateBaseline: argv.includes('--update-baseline'),
    skipPreflight: argv.includes('--skip-preflight'),
  };
}

function loadDataset(path: string): GoldenCase[] {
  const cases = JSON.parse(readFileSync(path, 'utf8')) as GoldenCase[];
  const issues = validateDataset(cases);
  if (issues.length > 0) {
    console.error(`Dataset ${path} has ${issues.length} problem(s):`);
    for (const issue of issues) {
      console.error(`  - ${issue.caseId}: ${issue.problem}`);
    }
    process.exit(2);
  }
  return cases;
}

/**
 * Fail fast before spending LLM calls: confirm the endpoint is reachable, the
 * token is accepted, and at least one repo is indexed (empty allowlist means
 * every positive case is doomed). A 404 means EVAL_TOKEN isn't set on the
 * worker; 401 means the token doesn't match.
 */
async function preflight(opts: CliOptions): Promise<void> {
  process.stdout.write('Preflight: checking endpoint, token, and index… ');
  try {
    const res = await askEval(
      { endpoint: opts.endpoint, token: opts.token, agentic: false },
      'beacon eval preflight: what does this repository do?',
    );
    if (res.allowlist.length === 0) {
      console.error(
        '\nFAIL: the worker has no indexed repos (empty allowlist). Index a ' +
          'repo first (e.g. `index owner/repo` in Slack) before running the eval.',
      );
      process.exit(2);
    }
    console.log(`ok (${res.allowlist.length} repo(s) indexed).`);
  } catch (err) {
    const msg = (err as Error).message;
    const hint = msg.includes('404')
      ? ' — EVAL_TOKEN is not set on the worker (route disabled).'
      : msg.includes('401')
        ? ' — token rejected; check EVAL_TOKEN matches the worker secret.'
        : '';
    console.error(`\nFAIL: preflight request failed: ${msg}${hint}`);
    process.exit(2);
  }
}

async function runCase(opts: CliOptions, c: GoldenCase): Promise<CaseResult> {
  try {
    const res = await askEval(
      { endpoint: opts.endpoint, token: opts.token, agentic: opts.agentic },
      c.question,
    );
    const score = scoreCase(c, res);
    const markers = [...res.answer.matchAll(/\[(\d{1,2})\]/g)].map((m) =>
      Number(m[1]),
    );
    const citedFiles = [
      ...new Set(
        markers
          .filter((n) => n >= 1 && n <= res.citations.length)
          .map((n) => `${res.citations[n - 1].repoFullName}/${res.citations[n - 1].path}`),
      ),
    ];
    const citationSources = sourceCounts(res.citations);
    const usedCitationSources = sourceCounts(
      markers
        .filter((n) => n >= 1 && n <= res.citations.length)
        .map((n) => res.citations[n - 1]!),
    );
    return {
      caseId: c.id,
      question: c.question,
      score,
      answer: res.answer,
      citations: res.citations,
      citedFiles,
      citationSources,
      usedCitationSources,
      timings: res.timings,
    };
  } catch (err) {
    return {
      caseId: c.id,
      question: c.question,
      score: {
        citationPrecision: null,
        citationRecall: null,
        citationF1: null,
        groundedness: 0,
        mustPassRate: null,
        sourceRecall: null,
        mustNotViolations: [],
        abstained: false,
        composite: 0,
      },
      answer: '',
      citations: [],
      citedFiles: [],
      citationSources: {},
      usedCitationSources: {},
      timings: { retrievalMs: 0, llmMs: 0, totalMs: 0 },
      error: (err as Error).message,
    };
  }
}

function sourceCounts(
  citations: Array<{ source?: string | null; sources?: Array<string | null> | null }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const citation of citations) {
    const sources = citation.sources?.length
      ? citation.sources
      : [citation.source ?? 'unknown'];
    for (const source of sources) {
      const key = source ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

async function runPool(opts: CliOptions, cases: GoldenCase[]): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(opts.concurrency, cases.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= cases.length) return;
        results[i] = await runCase(opts, cases[i]);
        const s = results[i].score.composite.toFixed(2);
        console.log(
          `  [${i + 1}/${cases.length}] ${results[i].caseId}: ${results[i].error ? `ERROR ${results[i].error}` : s}`,
        );
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function buildReport(opts: CliOptions, results: CaseResult[]): EvalReport {
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

  const f1s = results
    .map((r) => r.score.citationF1)
    .filter((x): x is number => x !== null);
  const sourceRecalls = results
    .map((r) => r.score.sourceRecall)
    .filter((x): x is number => x !== null);
  const abstainCases = results.filter((r) =>
    r.error === undefined &&
    r.score.citationF1 === null &&
    r.score.mustPassRate === null &&
    r.score.sourceRecall === null,
  );

  return {
    ranAt: new Date().toISOString(),
    endpoint: opts.endpoint,
    dataset: opts.dataset,
    agentic: opts.agentic,
    cases: results,
    summary: {
      compositeMean: mean(results.map((r) => r.score.composite)) ?? 0,
      citationF1Mean: mean(f1s),
      sourceRecallMean: mean(sourceRecalls),
      abstainAccuracy: mean(abstainCases.map((r) => r.score.composite)),
      failures: results.filter((r) => r.error !== undefined).length,
      totalMs: results.reduce((s, r) => s + r.timings.totalMs, 0),
    },
  };
}

function printReport(report: EvalReport, baseline: EvalReport | null): void {
  console.log('\ncase                          comp   f1     src    ground must   cited');
  for (const r of report.cases) {
    const fmt = (x: number | null): string =>
      x === null ? '  -  ' : x.toFixed(2).padEnd(5);
    console.log(
      `${r.caseId.padEnd(30).slice(0, 30)}${fmt(r.score.composite)}  ${fmt(r.score.citationF1)}  ${fmt(r.score.sourceRecall)}  ${fmt(r.score.groundedness)}  ${fmt(r.score.mustPassRate)}  ${r.citedFiles.length}${r.error ? '  ERROR' : ''}`,
    );
  }
  const s = report.summary;
  console.log(
    `\ncomposite mean: ${s.compositeMean.toFixed(4)}` +
      (s.citationF1Mean !== null ? ` | citation F1: ${s.citationF1Mean.toFixed(4)}` : '') +
      (s.sourceRecallMean !== null ? ` | source recall: ${s.sourceRecallMean.toFixed(4)}` : '') +
      (s.abstainAccuracy !== null ? ` | abstain: ${s.abstainAccuracy.toFixed(2)}` : '') +
      ` | failures: ${s.failures} | wall: ${(s.totalMs / 1000).toFixed(1)}s`,
  );
  if (baseline) {
    const delta = s.compositeMean - baseline.summary.compositeMean;
    const arrow = delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'unchanged';
    console.log(
      `baseline (${baseline.ranAt}): ${baseline.summary.compositeMean.toFixed(4)} -> ${arrow} ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const cases = loadDataset(opts.dataset);
  if (!opts.skipPreflight) await preflight(opts);
  console.log(
    `Running ${cases.length} cases against ${opts.endpoint} (agentic=${opts.agentic})…`,
  );

  const results = await runPool(opts, cases);
  const report = buildReport(opts, results);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = report.ranAt.replace(/[:.]/g, '-');
  const latestPath = join(RESULTS_DIR, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(report, null, 2));
  writeFileSync(join(RESULTS_DIR, `run-${stamp}.json`), JSON.stringify(report, null, 2));

  const baselinePath = join(RESULTS_DIR, 'baseline.json');
  const baseline = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as EvalReport)
    : null;
  printReport(report, baseline);

  if (opts.updateBaseline) {
    copyFileSync(latestPath, baselinePath);
    console.log('baseline updated.');
  }

  if (report.summary.compositeMean < opts.failUnder) {
    console.error(
      `FAIL: composite ${report.summary.compositeMean.toFixed(4)} < --fail-under ${opts.failUnder}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
