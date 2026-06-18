/**
 * Pure scoring for one eval case. This file is the locked metric of the
 * harness (the prepare.py of the autoresearch analogy): retrieval/prompt
 * changes are judged by it, so it must not be tuned to make a change look
 * good. Composite weights: citation F1 0.5, answerMust 0.3, groundedness 0.2,
 * expected citation source recall 0.2 (renormalized over the parts a case
 * defines); any answerMustNot match zeroes the case; negative cases score 1 iff
 * the answer cites nothing.
 */

import type {
  CaseScore,
  EvalAskResponse,
  EvalCitation,
  ExpectedFile,
  GoldenCase,
} from './types.js';

const WEIGHTS = {
  citationF1: 0.5,
  mustPassRate: 0.3,
  groundedness: 0.2,
  sourceRecall: 0.2,
};

/** [n] markers referenced in the answer (mirrors slack-bot format.ts). */
export function citedMarkers(answerText: string): Set<number> {
  const cited = new Set<number>();
  for (const m of answerText.matchAll(/\[(\d{1,2})\]/g)) {
    cited.add(Number(m[1]));
  }
  return cited;
}

/**
 * Path match is suffix-tolerant so golden files survive repo-root differences
 * (e.g. "src/signature.ts" matches "workers/slack-bot/src/signature.ts").
 */
export function fileMatches(expected: ExpectedFile, citation: EvalCitation): boolean {
  if (
    expected.repo &&
    expected.repo.toLowerCase() !== citation.repoFullName.toLowerCase()
  ) {
    return false;
  }
  const exp = expected.path.toLowerCase();
  const got = citation.path.toLowerCase();
  return got === exp || got.endsWith(`/${exp}`) || exp.endsWith(`/${got}`);
}

export function scoreCase(c: GoldenCase, r: EvalAskResponse): CaseScore {
  const markers = citedMarkers(r.answer);
  const validMarkers = [...markers].filter(
    (n) => n >= 1 && n <= r.citations.length,
  );
  const groundedness = markers.size === 0 ? 1 : validMarkers.length / markers.size;
  const abstained = markers.size === 0;

  // Citations the answer actually used, deduped to repo/path granularity.
  const citedFiles = new Map<string, EvalCitation>();
  for (const n of validMarkers) {
    const cit = r.citations[n - 1];
    citedFiles.set(`${cit.repoFullName.toLowerCase()}|${cit.path.toLowerCase()}`, cit);
  }

  let citationPrecision: number | null = null;
  let citationRecall: number | null = null;
  let citationF1: number | null = null;
  if (c.expectedFiles && c.expectedFiles.length > 0) {
    const cited = [...citedFiles.values()];
    const hits = c.expectedFiles.filter((exp) =>
      cited.some((cit) => fileMatches(exp, cit)),
    ).length;
    const relevantCited = cited.filter((cit) =>
      c.expectedFiles!.some((exp) => fileMatches(exp, cit)),
    ).length;
    citationRecall = hits / c.expectedFiles.length;
    citationPrecision = cited.length === 0 ? 0 : relevantCited / cited.length;
    citationF1 =
      citationPrecision + citationRecall === 0
        ? 0
        : (2 * citationPrecision * citationRecall) /
          (citationPrecision + citationRecall);
  }

  let mustPassRate: number | null = null;
  if (c.answerMust && c.answerMust.length > 0) {
    const passed = c.answerMust.filter((p) =>
      new RegExp(p, 'i').test(r.answer),
    ).length;
    mustPassRate = passed / c.answerMust.length;
  }

  const mustNotViolations = (c.answerMustNot ?? []).filter((p) =>
    new RegExp(p, 'i').test(r.answer),
  );

  let sourceRecall: number | null = null;
  if (c.expectedCitationSources && c.expectedCitationSources.length > 0) {
    const citedSources = new Set(
      validMarkers.flatMap((n) => citationSources(r.citations[n - 1])),
    );
    const hits = c.expectedCitationSources.filter((source) =>
      citedSources.has(source),
    ).length;
    sourceRecall = hits / c.expectedCitationSources.length;
  }

  return {
    citationPrecision,
    citationRecall,
    citationF1,
    groundedness,
    mustPassRate,
    sourceRecall,
    mustNotViolations,
    abstained,
    composite: composite(c, {
      citationF1,
      mustPassRate,
      sourceRecall,
      groundedness,
      mustNotViolations,
      abstained,
    }),
  };
}

function composite(
  c: GoldenCase,
  parts: {
    citationF1: number | null;
    mustPassRate: number | null;
    sourceRecall: number | null;
    groundedness: number;
    mustNotViolations: string[];
    abstained: boolean;
  },
): number {
  if (parts.mustNotViolations.length > 0) return 0;
  if (c.expectNoAnswer) return parts.abstained ? 1 : 0;

  const components: Array<{ weight: number; value: number }> = [
    { weight: WEIGHTS.groundedness, value: parts.groundedness },
  ];
  if (parts.citationF1 !== null) {
    components.push({ weight: WEIGHTS.citationF1, value: parts.citationF1 });
  }
  if (parts.mustPassRate !== null) {
    components.push({ weight: WEIGHTS.mustPassRate, value: parts.mustPassRate });
  }
  if (parts.sourceRecall !== null) {
    components.push({ weight: WEIGHTS.sourceRecall, value: parts.sourceRecall });
  }

  const totalWeight = components.reduce((s, p) => s + p.weight, 0);
  const weighted = components.reduce((s, p) => s + p.weight * p.value, 0);
  return weighted / totalWeight;
}

function citationSources(citation: EvalCitation): NonNullable<EvalCitation['source']>[] {
  return citation.sources?.length
    ? citation.sources
    : citation.source
      ? [citation.source]
      : [];
}
