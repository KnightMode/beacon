/**
 * Eval harness contracts: golden dataset cases, the /eval/ask response shape,
 * per-case scores, and the aggregate report written to results/.
 */

/** A file the answer is expected to cite. Matched by path (suffix-tolerant). */
export interface ExpectedFile {
  path: string;
  /** Optional owner/name; when set the citation's repo must match (case-insensitive). */
  repo?: string;
}

export interface GoldenCase {
  id: string;
  question: string;
  /** Files a correct answer should cite. Omit for negative (abstain) cases. */
  expectedFiles?: ExpectedFile[];
  /** Case-insensitive regexes that must all match the answer text. */
  answerMust?: string[];
  /** Case-insensitive regexes that must NOT match the answer text (hard fail). */
  answerMustNot?: string[];
  /** True when the correct behavior is to abstain (cite nothing). */
  expectNoAnswer?: boolean;
  notes?: string;
}

/** Citation shape returned by the worker (mirrors @scintel/shared Citation). */
export interface EvalCitation {
  repoFullName: string;
  path: string;
  startLine: number;
  endLine: number;
  commitSha?: string | null;
  source?: 'lexical' | 'vector' | 'graph' | 'zoekt' | 'scip';
}

/** Successful body of POST /eval/ask. */
export interface EvalAskResponse {
  ok: true;
  question: string;
  answer: string;
  citations: EvalCitation[];
  usedChunks: number;
  candidates: number;
  allowlist: string[];
  timings: { retrievalMs: number; llmMs: number; totalMs: number };
}

export interface CaseScore {
  /** File-level precision/recall/F1 over citations the answer actually used. */
  citationPrecision: number | null;
  citationRecall: number | null;
  citationF1: number | null;
  /** Fraction of [n] markers in the answer that map to a real citation. */
  groundedness: number;
  /** Fraction of answerMust regexes that matched. */
  mustPassRate: number | null;
  /** answerMustNot regexes that matched (each is a hard fail). */
  mustNotViolations: string[];
  /** The answer used no citations (the abstain signal for negative cases). */
  abstained: boolean;
  /** Single 0..1 score for the case (the autoresearch-style metric input). */
  composite: number;
}

export interface CaseResult {
  caseId: string;
  question: string;
  score: CaseScore;
  answer: string;
  citedFiles: string[];
  citationSources: Record<string, number>;
  usedCitationSources: Record<string, number>;
  timings: EvalAskResponse['timings'];
  error?: string;
}

export interface EvalReport {
  ranAt: string;
  endpoint: string;
  dataset: string;
  agentic: boolean;
  cases: CaseResult[];
  summary: {
    compositeMean: number;
    citationF1Mean: number | null;
    abstainAccuracy: number | null;
    failures: number;
    totalMs: number;
  };
}
