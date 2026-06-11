/**
 * Pure helpers for CI-failure triage: condense a GitHub Actions job log into
 * an error-focused excerpt, and classify failures that look transient/infra
 * (those get a short note instead of an LLM triage — an LLM handed a network
 * timeout and asked "what's the fix" will confidently invent one).
 */

/** GitHub Actions job logs prefix every line with an ISO-8601 timestamp. */
export function stripLogTimestamps(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, '');
}

const ANSI_ESCAPES = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPES, '');
}

/**
 * Reduce a full job log to the part worth showing an LLM: every `##[error]`
 * line with a few lines of preceding context, plus a window of lines ending
 * just after the last error (errors cluster at the point of failure). Logs
 * without an explicit error marker fall back to the global tail. Capped at
 * `maxChars` keeping the END — the failure evidence lives there.
 */
export function extractErrorExcerpt(log: string, maxChars = 8_000): string {
  const lines = log
    .split('\n')
    .map((l) => stripAnsi(stripLogTimestamps(l)));

  const errorIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes('##[error]')) errorIdxs.push(i);
  }

  const selected = new Set<number>();
  if (errorIdxs.length > 0) {
    for (const idx of errorIdxs) {
      for (let i = Math.max(0, idx - 5); i <= idx; i++) selected.add(i);
    }
    const last = errorIdxs[errorIdxs.length - 1]!;
    const end = Math.min(lines.length - 1, last + 10);
    for (let i = Math.max(0, end - 150); i <= end; i++) selected.add(i);
  } else {
    for (let i = Math.max(0, lines.length - 150); i < lines.length; i++) {
      selected.add(i);
    }
  }

  const ordered = [...selected].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -1;
  for (const i of ordered) {
    if (prev >= 0 && i !== prev + 1) out.push('…');
    out.push(lines[i]!);
    prev = i;
  }

  let text = out.join('\n').trim();
  if (text.length > maxChars) {
    text = `…${text.slice(text.length - maxChars + 1)}`;
  }
  return text;
}

/** First line carrying an error marker — used to seed the retrieval query. */
export function topErrorLine(excerpt: string): string | null {
  for (const line of excerpt.split('\n')) {
    const idx = line.indexOf('##[error]');
    if (idx >= 0) {
      const msg = line.slice(idx + '##[error]'.length).trim();
      if (msg) return msg;
    }
  }
  return null;
}

const TRANSIENT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i, reason: 'network error' },
  { re: /could not resolve host|tls handshake/i, reason: 'network error' },
  { re: /\b429\b|too many requests|rate limit/i, reason: 'rate limit' },
  { re: /out of memory|\bOOM\b|exit code 137/i, reason: 'out of memory' },
  {
    re: /toomanyrequests|error pulling image|failed to pull (the )?image/i,
    reason: 'container registry',
  },
  { re: /no space left on device/i, reason: 'runner disk full' },
  {
    re: /lost communication with the server|runner has received a shutdown signal/i,
    reason: 'runner infrastructure',
  },
  { re: /\btimed? ?out\b/i, reason: 'timeout' },
];

/**
 * Deterministic transient/infra classifier. Runs over the (already
 * error-focused) excerpt; the first matching signature wins. Code failures —
 * assertion failures, compile/type errors, lint — match nothing here and
 * proceed to full triage.
 */
export function classifyTransient(excerpt: string): {
  transient: boolean;
  reason?: string;
} {
  for (const { re, reason } of TRANSIENT_PATTERNS) {
    if (re.test(excerpt)) return { transient: true, reason };
  }
  return { transient: false };
}

/** File paths mentioned in the excerpt — extra lexical signal for retrieval. */
export function harvestPaths(excerpt: string, limit = 8): string[] {
  const found = new Set<string>();
  for (const m of excerpt.matchAll(
    /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|go|py|rb|java|rs|sql|toml|ya?ml|json)\b/g,
  )) {
    found.add(m[0]);
    if (found.size >= limit) break;
  }
  return [...found];
}
