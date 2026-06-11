import { describe, it, expect } from 'vitest';
import { scoreCase, fileMatches, citedMarkers } from '../src/score.js';
import type { EvalAskResponse, GoldenCase } from '../src/types.js';

function response(
  answer: string,
  paths: string[],
  repo = 'knightmode/beacon',
): EvalAskResponse {
  return {
    ok: true,
    question: 'q',
    answer,
    citations: paths.map((path) => ({
      repoFullName: repo,
      path,
      startLine: 1,
      endLine: 10,
      commitSha: 'abc',
    })),
    usedChunks: paths.length,
    candidates: paths.length,
    allowlist: [repo],
    timings: { retrievalMs: 1, llmMs: 1, totalMs: 2 },
  };
}

describe('citedMarkers', () => {
  it('extracts unique markers', () => {
    expect(citedMarkers('See [1][3], also [3].')).toEqual(new Set([1, 3]));
  });
});

describe('fileMatches', () => {
  it('matches exact and suffix paths', () => {
    const cit = response('', ['workers/slack-bot/src/signature.ts']).citations[0];
    expect(fileMatches({ path: 'workers/slack-bot/src/signature.ts' }, cit)).toBe(true);
    expect(fileMatches({ path: 'src/signature.ts' }, cit)).toBe(true);
    expect(fileMatches({ path: 'src/other.ts' }, cit)).toBe(false);
  });

  it('does not match partial filename segments', () => {
    const cit = response('', ['src/resignature.ts']).citations[0];
    expect(fileMatches({ path: 'signature.ts' }, cit)).toBe(false);
  });

  it('enforces repo when specified, case-insensitively', () => {
    const cit = response('', ['src/a.ts'], 'KnightMode/beacon').citations[0];
    expect(fileMatches({ path: 'src/a.ts', repo: 'knightmode/beacon' }, cit)).toBe(true);
    expect(fileMatches({ path: 'src/a.ts', repo: 'other/repo' }, cit)).toBe(false);
  });
});

describe('scoreCase', () => {
  const goldenCase: GoldenCase = {
    id: 't',
    question: 'q',
    expectedFiles: [{ path: 'src/signature.ts' }],
    answerMust: ['hmac'],
  };

  it('gives full marks for a perfect answer', () => {
    const r = response('Verified via HMAC [1].', ['workers/x/src/signature.ts']);
    const s = scoreCase(goldenCase, r);
    expect(s.citationRecall).toBe(1);
    expect(s.citationPrecision).toBe(1);
    expect(s.citationF1).toBe(1);
    expect(s.mustPassRate).toBe(1);
    expect(s.groundedness).toBe(1);
    expect(s.composite).toBe(1);
  });

  it('penalizes citing only irrelevant files', () => {
    const r = response('It uses HMAC [1].', ['src/unrelated.ts']);
    const s = scoreCase(goldenCase, r);
    expect(s.citationF1).toBe(0);
    expect(s.composite).toBeLessThan(1);
    expect(s.composite).toBeGreaterThan(0); // must + groundedness still pass
  });

  it('treats out-of-range markers as ungrounded', () => {
    const r = response('HMAC check [1][7].', ['src/signature.ts']);
    const s = scoreCase(goldenCase, r);
    expect(s.groundedness).toBe(0.5);
  });

  it('zeroes the case on an answerMustNot violation', () => {
    const c: GoldenCase = { ...goldenCase, answerMustNot: ['kubectl'] };
    const r = response('Run kubectl [1].', ['src/signature.ts']);
    expect(scoreCase(c, r).composite).toBe(0);
  });

  it('scores negative cases by abstention', () => {
    const c: GoldenCase = { id: 'n', question: 'q', expectNoAnswer: true };
    const abstain = scoreCase(c, response("I couldn't find anything relevant.", []));
    expect(abstain.composite).toBe(1);
    const hallucinated = scoreCase(c, response('Sure, see [1].', ['src/a.ts']));
    expect(hallucinated.composite).toBe(0);
  });

  it('renormalizes weights when a case has no answerMust', () => {
    const c: GoldenCase = {
      id: 't2',
      question: 'q',
      expectedFiles: [{ path: 'src/signature.ts' }],
    };
    const r = response('Verified here [1].', ['src/signature.ts']);
    expect(scoreCase(c, r).composite).toBe(1);
  });
});
