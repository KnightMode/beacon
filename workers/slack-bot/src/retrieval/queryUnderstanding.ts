/**
 * Lightweight, heuristic query understanding. Extracts candidate symbols/terms
 * and a coarse intent from the natural-language question. No LLM call here —
 * this stays cheap and deterministic in the request path.
 */

export interface ParsedQuery {
  raw: string;
  /** Candidate identifiers: CamelCase, snake_case, dotted, or `code` spans. */
  symbols: string[];
  /** Lowercased keyword terms with stopwords removed. */
  terms: string[];
  intent: 'definition' | 'usage' | 'explanation' | 'general';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'how', 'what', 'where', 'why', 'when', 'does',
  'do', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'this', 'that',
  'i', 'we', 'you', 'it', 'can', 'please', 'show', 'me', 'find', 'code',
  'function', 'class', 'method', 'repo', 'repository',
]);

export function parseQuery(raw: string): ParsedQuery {
  const symbols = new Set<string>();

  for (const m of raw.matchAll(/`([^`]+)`/g)) symbols.add(m[1]!.trim());
  for (const m of raw.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)\b/g)) {
    symbols.add(m[1]!);
  }
  for (const m of raw.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*)\b/g)) symbols.add(m[1]!);
  for (const m of raw.matchAll(/\b([A-Z][a-z0-9]+[A-Za-z0-9]*)\b/g)) symbols.add(m[1]!);
  for (const m of raw.matchAll(/\b([a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) symbols.add(m[1]!);

  const terms = raw
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

  return {
    raw,
    symbols: [...symbols]
      .filter((s) => s.length > 1 && !STOPWORDS.has(s.toLowerCase()))
      .slice(0, 12),
    terms: [...new Set(terms)].slice(0, 20),
    intent: detectIntent(raw),
  };
}

function detectIntent(raw: string): ParsedQuery['intent'] {
  const q = raw.toLowerCase();
  if (/\b(where|defined|definition|declare)\b/.test(q)) return 'definition';
  if (/\b(call|called|use|usage|used|invoke)\b/.test(q)) return 'usage';
  if (/\b(how|why|explain|what does|walk me)\b/.test(q)) return 'explanation';
  return 'general';
}
