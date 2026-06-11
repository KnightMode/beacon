import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../src/validate.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('validateDataset', () => {
  it('accepts the shipped golden set', () => {
    const data = JSON.parse(
      readFileSync(resolve(PKG_ROOT, 'golden/beacon.json'), 'utf8'),
    );
    expect(validateDataset(data)).toEqual([]);
  });

  it('flags duplicate ids', () => {
    const issues = validateDataset([
      { id: 'a', question: 'q', answerMust: ['x'] },
      { id: 'a', question: 'q2', answerMust: ['y'] },
    ]);
    expect(issues.some((i) => i.problem === 'duplicate id')).toBe(true);
  });

  it('flags invalid regexes', () => {
    const issues = validateDataset([
      { id: 'a', question: 'q', answerMust: ['('] },
    ]);
    expect(issues.some((i) => i.problem.includes('invalid regex'))).toBe(true);
  });

  it('flags a contradictory positive+negative case', () => {
    const issues = validateDataset([
      { id: 'a', question: 'q', expectNoAnswer: true, answerMust: ['x'] },
    ]);
    expect(issues.some((i) => i.problem.includes('cannot be combined'))).toBe(true);
  });

  it('flags a case with no assertions', () => {
    const issues = validateDataset([{ id: 'a', question: 'q' }]);
    expect(issues.some((i) => i.problem.includes('positive case needs'))).toBe(true);
  });

  it('rejects a non-array dataset', () => {
    expect(validateDataset({})).toEqual([
      { caseId: '(root)', problem: 'dataset must be a JSON array' },
    ]);
  });
});
