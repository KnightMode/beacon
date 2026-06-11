/**
 * Offline dataset validation: catches authoring mistakes (bad regexes,
 * duplicate ids, contradictory positive/negative cases) before a run burns
 * real LLM calls against the deployed worker. Pure — no network.
 */

import type { GoldenCase } from './types.js';

export interface ValidationIssue {
  caseId: string;
  problem: string;
}

export function validateDataset(cases: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(cases)) {
    return [{ caseId: '(root)', problem: 'dataset must be a JSON array' }];
  }

  const seen = new Set<string>();
  cases.forEach((raw, i) => {
    const c = raw as Partial<GoldenCase>;
    const id = c.id ?? `(index ${i})`;

    if (!c.id || typeof c.id !== 'string') {
      issues.push({ caseId: id, problem: 'missing string "id"' });
    } else if (seen.has(c.id)) {
      issues.push({ caseId: id, problem: 'duplicate id' });
    } else {
      seen.add(c.id);
    }

    if (!c.question || typeof c.question !== 'string') {
      issues.push({ caseId: id, problem: 'missing string "question"' });
    }

    const positive =
      (c.expectedFiles?.length ?? 0) > 0 || (c.answerMust?.length ?? 0) > 0;
    if (c.expectNoAnswer && positive) {
      issues.push({
        caseId: id,
        problem: 'expectNoAnswer cannot be combined with expectedFiles/answerMust',
      });
    }
    if (!c.expectNoAnswer && !positive) {
      issues.push({
        caseId: id,
        problem: 'positive case needs expectedFiles and/or answerMust (or set expectNoAnswer)',
      });
    }

    for (const exp of c.expectedFiles ?? []) {
      if (!exp.path || typeof exp.path !== 'string') {
        issues.push({ caseId: id, problem: 'expectedFiles entry missing "path"' });
      }
    }

    for (const field of ['answerMust', 'answerMustNot'] as const) {
      for (const pattern of c[field] ?? []) {
        try {
          new RegExp(pattern, 'i');
        } catch (err) {
          issues.push({
            caseId: id,
            problem: `${field} has invalid regex ${JSON.stringify(pattern)}: ${(err as Error).message}`,
          });
        }
      }
    }
  });

  return issues;
}
