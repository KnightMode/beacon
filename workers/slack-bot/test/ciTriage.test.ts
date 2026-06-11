import { describe, it, expect } from 'vitest';
import {
  stripLogTimestamps,
  stripAnsi,
  extractErrorExcerpt,
  topErrorLine,
  classifyTransient,
  harvestPaths,
} from '../src/ci/logExcerpt.js';
import {
  buildTriageMessage,
  buildTransientMessage,
} from '../src/ci/triageMessage.js';
import { parseRepoFromText } from '../src/repoTarget.js';
import { detectIntent, parseNotifyTarget } from '../src/intent.js';
import type { TriageJob } from '@scintel/shared';

const TS = '2026-06-11T03:14:15.9265358Z ';

function logLines(lines: string[]): string {
  return lines.map((l) => `${TS}${l}`).join('\n');
}

const JOB: TriageJob = {
  jobType: 'CI_TRIAGE',
  repoId: 'knightmode/viper',
  repoFullName: 'KnightMode/viper',
  runId: 4242,
  runAttempt: 1,
  workflowName: 'CI',
  headBranch: 'feature/parser',
  headSha: 'abc1234def5678',
  runHtmlUrl: 'https://github.com/KnightMode/viper/actions/runs/4242',
  enqueuedAt: '2026-06-11T00:00:00.000Z',
};

describe('stripLogTimestamps', () => {
  it('removes the ISO prefix and keeps the content', () => {
    expect(stripLogTimestamps(`${TS}npm ERR! code 1`)).toBe('npm ERR! code 1');
  });

  it('leaves unprefixed lines alone', () => {
    expect(stripLogTimestamps('plain line')).toBe('plain line');
  });
});

describe('stripAnsi', () => {
  it('removes color codes but not ##[error] markers', () => {
    expect(stripAnsi('\u001b[31mFAIL\u001b[0m ##[error]boom')).toBe(
      'FAIL ##[error]boom',
    );
  });
});

describe('extractErrorExcerpt', () => {
  it('keeps ##[error] lines with surrounding context', () => {
    const log = logLines([
      ...Array.from({ length: 200 }, (_, i) => `setup line ${i}`),
      '##[group]Run npm test',
      'FAIL test/parser.test.ts',
      'Expected 4 to equal 5',
      '##[error]Process completed with exit code 1.',
      '##[endgroup]',
    ]);
    const excerpt = extractErrorExcerpt(log);
    expect(excerpt).toContain('##[error]Process completed with exit code 1.');
    expect(excerpt).toContain('Expected 4 to equal 5');
    expect(excerpt).not.toContain(TS.trim());
  });

  it('falls back to the tail when no error marker exists', () => {
    const log = logLines(
      Array.from({ length: 400 }, (_, i) => `line ${i}`),
    );
    const excerpt = extractErrorExcerpt(log);
    expect(excerpt).toContain('line 399');
    expect(excerpt).not.toContain('line 100');
  });

  it('caps at maxChars keeping the end', () => {
    const log = logLines([
      ...Array.from({ length: 100 }, (_, i) => `noise ${i} ${'x'.repeat(200)}`),
      '##[error]the real failure',
    ]);
    const excerpt = extractErrorExcerpt(log, 2000);
    expect(excerpt.length).toBeLessThanOrEqual(2000);
    expect(excerpt).toContain('##[error]the real failure');
  });
});

describe('topErrorLine', () => {
  it('returns the first error message', () => {
    const excerpt = 'some line\n##[error]Type error in foo.ts\n##[error]second';
    expect(topErrorLine(excerpt)).toBe('Type error in foo.ts');
  });

  it('returns null when absent', () => {
    expect(topErrorLine('all good')).toBe(null);
  });
});

describe('classifyTransient', () => {
  const positives: Array<[string, string]> = [
    ['request to https://registry.npmjs.org failed: ETIMEDOUT', 'network error'],
    ['##[error]The operation was canceled. 429 Too Many Requests', 'rate limit'],
    ['FATAL ERROR: JavaScript heap out of memory', 'out of memory'],
    ['process exited with exit code 137', 'out of memory'],
    ['toomanyrequests: You have reached your pull rate limit', 'rate limit'],
    ['##[error]No space left on device', 'runner disk full'],
    ['The runner has received a shutdown signal', 'runner infrastructure'],
    ['##[error]The job running on runner X timed out', 'timeout'],
  ];
  for (const [excerpt, _reason] of positives) {
    it(`flags transient: ${excerpt.slice(0, 40)}`, () => {
      expect(classifyTransient(excerpt).transient).toBe(true);
    });
  }

  it('does not flag a test assertion failure', () => {
    const excerpt = [
      'FAIL test/retrieval.test.ts',
      'AssertionError: expected [ 1, 2 ] to deeply equal [ 1, 2, 3 ]',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    expect(classifyTransient(excerpt).transient).toBe(false);
  });

  it('does not flag a TypeScript compile error', () => {
    const excerpt = [
      "src/retrieval/pipeline.ts(42,7): error TS2345: Argument of type 'string'",
      '##[error]Process completed with exit code 2.',
    ].join('\n');
    expect(classifyTransient(excerpt).transient).toBe(false);
  });
});

describe('harvestPaths', () => {
  it('extracts repo-relative source paths', () => {
    const excerpt =
      'FAIL workers/slack-bot/test/retrieval.test.ts\n at src/retrieval/rerank.ts:12';
    expect(harvestPaths(excerpt)).toEqual([
      'workers/slack-bot/test/retrieval.test.ts',
      'src/retrieval/rerank.ts',
    ]);
  });
});

describe('triage message builders', () => {
  it('full triage text carries repo, run URL, and the rocket CTA', () => {
    const msg = buildTriageMessage(JOB, 'Likely cause: parser change [1]', [
      {
        repoFullName: 'KnightMode/viper',
        path: 'src/parser.ts',
        startLine: 10,
        endLine: 20,
        commitSha: 'abc1234',
      },
    ]);
    expect(msg.text).toContain('KnightMode/viper');
    expect(msg.text).toContain(JOB.runHtmlUrl);
    expect(msg.text).toContain(':rocket:');
    expect(JSON.stringify(msg.blocks)).toContain('Sources');
  });

  it('reaction flow resolves the right repo from the message text', () => {
    // The analysis mentions a file path before any owner/repo token — the
    // leading run URL must still win repo resolution for createPrFromThread.
    const msg = buildTriageMessage(
      JOB,
      'The failure in workers/slack-bot/src/foo.ts is caused by …',
      [],
    );
    expect(parseRepoFromText(msg.text)?.fullName).toBe('KnightMode/viper');
  });

  it('transient note links the run and recommends a re-run', () => {
    const msg = buildTransientMessage(JOB, 'rate limit');
    expect(msg.text).toContain('likely transient');
    expect(msg.text).toContain('rate limit');
    expect(msg.text).toContain(JOB.runHtmlUrl);
    expect(parseRepoFromText(msg.text)?.fullName).toBe('KnightMode/viper');
  });
});

describe('notify_repo intent', () => {
  it('parses "notify owner/repo here"', () => {
    expect(detectIntent('notify KnightMode/beacon here')).toBe('notify_repo');
    expect(parseNotifyTarget('notify KnightMode/beacon here')).toEqual({
      repo: 'KnightMode/beacon',
      channelId: null,
    });
  });

  it('parses an explicit channel mention', () => {
    const text = 'notify owner/repo in <#C0123ABC|ci-alerts>';
    expect(detectIntent(text)).toBe('notify_repo');
    expect(parseNotifyTarget(text)).toEqual({
      repo: 'owner/repo',
      channelId: 'C0123ABC',
    });
  });

  it('does not hijack other phrasings or intents', () => {
    expect(detectIntent('notify me when done')).toBe('qa');
    expect(detectIntent('index KnightMode/beacon')).toBe('index_repo');
    expect(detectIntent('index status')).toBe('index_status');
    expect(detectIntent('create pr: fix the parser')).toBe('create_pr');
  });
});
