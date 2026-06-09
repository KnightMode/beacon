/**
 * Lightweight secret scanning + redaction. Runs over each chunk before
 * embedding so obvious credentials never reach the vector store or the LLM.
 *
 * This is heuristic (not exhaustive). It errs toward redacting rather than
 * leaking. Each rule has a name so callers can log what matched.
 */

export interface SecretRule {
  name: string;
  pattern: RegExp;
}

/** Note: patterns are recreated per call to avoid shared lastIndex state. */
function rules(): SecretRule[] {
  return [
    { name: 'aws_access_key_id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    {
      name: 'aws_secret_access_key',
      pattern:
        /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi,
    },
    { name: 'github_pat', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
    { name: 'github_fine_grained_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
    { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
    { name: 'stripe_key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g },
    { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
    { name: 'private_key_block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
    { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    {
      name: 'generic_assignment',
      pattern:
        /\b(?:api[_-]?key|secret|passwd|password|token|access[_-]?token|client[_-]?secret)\b\s*[=:]\s*["'][^"'\n]{8,}["']/gi,
    },
  ];
}

export interface SecretScanResult {
  hasSecret: boolean;
  matchedRules: string[];
}

export function scanForSecrets(content: string): SecretScanResult {
  const matched: string[] = [];
  for (const rule of rules()) {
    if (rule.pattern.test(content)) {
      matched.push(rule.name);
    }
  }
  return { hasSecret: matched.length > 0, matchedRules: matched };
}

/** Replace any matched secret spans with a redaction marker. */
export function redactSecrets(content: string): {
  redacted: string;
  matchedRules: string[];
} {
  let out = content;
  const matched: string[] = [];
  for (const rule of rules()) {
    if (rule.pattern.test(out)) {
      matched.push(rule.name);
      out = out.replace(rule.pattern, `«redacted:${rule.name}»`);
    }
  }
  return { redacted: out, matchedRules: matched };
}
