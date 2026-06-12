import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  isTreeSitterLanguage,
  shouldIndexFile,
  scanForSecrets,
  redactSecrets,
  sha256Hex,
} from '../src/index.js';

describe('detectLanguage', () => {
  it('maps known extensions', () => {
    expect(detectLanguage('main.go')).toBe('go');
    expect(detectLanguage('src/app.ts')).toBe('typescript');
    expect(detectLanguage('src/app.tsx')).toBe('typescript');
    expect(detectLanguage('util.py')).toBe('python');
    expect(detectLanguage('README.md')).toBe('markdown');
  });

  it('returns null for unknown extensions', () => {
    expect(detectLanguage('image.heic')).toBeNull();
    expect(detectLanguage('Makefile')).toBeNull();
  });

  it('flags tree-sitter languages', () => {
    expect(isTreeSitterLanguage('go')).toBe(true);
    expect(isTreeSitterLanguage('python')).toBe(true);
    expect(isTreeSitterLanguage('markdown')).toBe(false);
    expect(isTreeSitterLanguage(null)).toBe(false);
  });
});

describe('shouldIndexFile', () => {
  it('skips ignored directories', () => {
    expect(shouldIndexFile('node_modules/foo/index.js').include).toBe(false);
    expect(shouldIndexFile('vendor/x/y.go').include).toBe(false);
    expect(shouldIndexFile('a/dist/b.js').include).toBe(false);
  });

  it('skips lockfiles and binaries', () => {
    expect(shouldIndexFile('package-lock.json').include).toBe(false);
    expect(shouldIndexFile('logo.png').include).toBe(false);
    expect(shouldIndexFile('app.min.js').include).toBe(false);
  });

  it('skips oversized files', () => {
    expect(shouldIndexFile('big.go', 5_000_000).include).toBe(false);
  });

  it('includes normal source files', () => {
    expect(shouldIndexFile('src/server/main.go').include).toBe(true);
    expect(shouldIndexFile('lib/handler.ts', 1234).include).toBe(true);
  });

  it('skips eval answer keys to avoid test contamination', () => {
    expect(shouldIndexFile('packages/eval/golden/beacon.json').include).toBe(false);
    expect(shouldIndexFile('eval/golden/cases.json').include).toBe(false);
  });

  it('does not mistake similarly-named paths for eval answer keys', () => {
    expect(shouldIndexFile('src/retrieval/golden/fixture.ts').include).toBe(true);
    expect(shouldIndexFile('packages/eval/src/run.ts').include).toBe(true);
  });
});

describe('secret scanning', () => {
  it('detects common secret formats', () => {
    expect(scanForSecrets('AKIAIOSFODNN7EXAMPLE').hasSecret).toBe(true);
    expect(scanForSecrets('token = "supersecretvalue123"').hasSecret).toBe(true);
    expect(scanForSecrets('const x = 1;').hasSecret).toBe(false);
  });

  it('redacts matched secrets', () => {
    const { redacted, matchedRules } = redactSecrets(
      'aws = AKIAIOSFODNN7EXAMPLE',
    );
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(matchedRules).toContain('aws_access_key_id');
  });
});

describe('sha256Hex', () => {
  it('hashes deterministically', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});
