import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  detectLanguage,
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToUtf8,
  createRepositoryDispatch,
  decryptSecretValue,
  encryptSecretValue,
  githubJsonHeaders,
  isEncryptedSecretValue,
  isValidRepoFullName,
  parseRepoRef,
  repoIdFor,
  isTreeSitterLanguage,
  shouldIndexFile,
  scanForSecrets,
  redactSecrets,
  sha256Hex,
} from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('encoding utilities', () => {
  it('round-trips base64 and base64url bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    expect(bytesToUtf8(base64UrlToBytes(bytesToBase64Url(new TextEncoder().encode('hello'))))).toBe(
      'hello',
    );
  });
});

describe('secret crypto', () => {
  it('encrypts with AES-GCM and decrypts the encrypted value', async () => {
    const encrypted = await encryptSecretValue('xoxb-secret', 'workspace-secret');

    expect(isEncryptedSecretValue(encrypted)).toBe(true);
    expect(encrypted).not.toContain('xoxb-secret');
    await expect(decryptSecretValue(encrypted, 'workspace-secret')).resolves.toBe(
      'xoxb-secret',
    );
  });

  it('passes through legacy plaintext values', async () => {
    await expect(decryptSecretValue('xoxb-legacy', 'workspace-secret')).resolves.toBe(
      'xoxb-legacy',
    );
  });
});

describe('GitHub API utilities', () => {
  it('builds standard JSON headers for GitHub REST calls', () => {
    expect(githubJsonHeaders('github-token', 'beacon-test')).toEqual({
      authorization: 'Bearer github-token',
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'beacon-test',
      'x-github-api-version': '2022-11-28',
    });
  });

  it('creates repository_dispatch requests for valid repo names', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createRepositoryDispatch({
        repository: 'KnightMode/beacon-app',
        token: 'github-token',
        eventType: 'index-repo',
        clientPayload: { repo: 'KnightMode/api', jobType: 'FULL_INDEX' },
        userAgent: 'beacon-test',
      }),
    ).resolves.toEqual({ ok: true, status: 204, body: '' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/KnightMode/beacon-app/dispatches',
      expect.objectContaining({
        method: 'POST',
        headers: githubJsonHeaders('github-token', 'beacon-test'),
        body: JSON.stringify({
          event_type: 'index-repo',
          client_payload: { repo: 'KnightMode/api', jobType: 'FULL_INDEX' },
        }),
      }),
    );
  });

  it('returns response text when repository_dispatch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad credentials', { status: 401 })),
    );

    await expect(
      createRepositoryDispatch({
        repository: 'KnightMode/beacon',
        token: 'github-token',
        eventType: 'index-repo',
        clientPayload: {},
        userAgent: 'beacon-test',
      }),
    ).resolves.toEqual({ ok: false, status: 401, body: 'bad credentials' });
  });
});

describe('repo reference utilities', () => {
  it('normalizes repo ids without changing display casing', () => {
    expect(repoIdFor(' KnightMode/Beacon ')).toBe('knightmode/beacon');
    expect(parseRepoRef('KnightMode/Beacon')).toEqual({
      fullName: 'KnightMode/Beacon',
      owner: 'KnightMode',
      name: 'Beacon',
      id: 'knightmode/beacon',
    });
  });

  it('validates owner/repo references conservatively', () => {
    expect(isValidRepoFullName('KnightMode/beacon.repo')).toBe(true);
    expect(isValidRepoFullName('KnightMode')).toBe(false);
    expect(isValidRepoFullName('KnightMode/beacon/extra')).toBe(false);
    expect(parseRepoRef('bad repo/name')).toBeNull();
  });
});
