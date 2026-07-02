import { describe, expect, it } from 'vitest';
import type { ScipReference, ScipSymbol } from '@scintel/shared';
import {
  ensureFileRows,
  fileIdFor,
  replaceScipFactsForRepo,
  upsertFiles,
  type FileRow,
} from '../src/core/store.js';
import type { D1Client } from '../src/cloudflare/d1.js';

interface RecordedExec {
  sql: string;
  params: unknown[];
}

/** Minimal D1Client stand-in that records exec() calls instead of hitting the network. */
function fakeD1(): { d1: D1Client; execCalls: RecordedExec[] } {
  const execCalls: RecordedExec[] = [];
  const d1 = {
    query: async () => [],
    exec: async (sql: string, params: unknown[] = []) => {
      execCalls.push({ sql, params });
    },
  } as unknown as D1Client;
  return { d1, execCalls };
}

function fileRow(path: string): FileRow {
  return {
    repoId: 'acme/widget',
    path,
    language: 'ts',
    sizeBytes: 100,
    contentHash: `hash-${path}`,
    gitBlobSha: `blob-${path}`,
    commitSha: 'deadbeef',
  };
}

function scipSymbol(id: string): ScipSymbol {
  return {
    id,
    repoId: 'acme/widget',
    symbol: `sym-${id}`,
    displayName: `sym-${id}`,
    kind: 'function',
    language: 'ts',
    path: `src/${id}.ts`,
    startLine: 1,
    endLine: 2,
    definitionChunkId: null,
    commitSha: 'deadbeef',
  };
}

function scipReference(id: string, symbolId: string): ScipReference {
  return {
    id,
    repoId: 'acme/widget',
    symbolId,
    role: 'reference',
    path: `src/${id}.ts`,
    startLine: 1,
    endLine: 1,
    enclosingSymbol: null,
    commitSha: 'deadbeef',
  };
}

describe('upsertFiles', () => {
  it('stays under the 100 bound-param cap per statement (12 rows/insert)', async () => {
    const { d1, execCalls } = fakeD1();
    const rows = Array.from({ length: 25 }, (_, i) => fileRow(`src/file${i}.ts`));
    await upsertFiles(d1, rows);

    // 8 bound params/row * 12 rows/statement = 96 <= 100; 25 rows -> 3 statements.
    expect(execCalls).toHaveLength(3);
    expect(execCalls[0]!.params).toHaveLength(12 * 8);
    expect(execCalls[1]!.params).toHaveLength(12 * 8);
    expect(execCalls[2]!.params).toHaveLength(1 * 8);
    for (const call of execCalls) {
      expect(call.params.length).toBeLessThanOrEqual(100);
      expect(call.sql).toContain('INSERT INTO files');
      expect(call.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    }

    // Every row's id, repo/path-derived, is present among the bound params.
    const allParams = execCalls.flatMap((c) => c.params);
    for (const row of rows) {
      expect(allParams).toContain(fileIdFor(row.repoId, row.path));
      expect(allParams).toContain(row.contentHash);
    }
  });

  it('is a no-op for an empty row list', async () => {
    const { d1, execCalls } = fakeD1();
    await upsertFiles(d1, []);
    expect(execCalls).toHaveLength(0);
  });
});

describe('ensureFileRows', () => {
  it('inserts placeholder rows without touching hash columns (20 rows/statement)', async () => {
    const { d1, execCalls } = fakeD1();
    const rows = Array.from({ length: 21 }, (_, i) => ({
      repoId: 'acme/widget',
      path: `src/file${i}.ts`,
      language: 'ts',
      sizeBytes: 100,
    }));
    await ensureFileRows(d1, rows);

    // 5 bound params/row * 20 rows/statement = 100; 21 rows -> 2 statements.
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]!.params).toHaveLength(20 * 5);
    expect(execCalls[1]!.params).toHaveLength(1 * 5);
    for (const call of execCalls) {
      expect(call.params.length).toBeLessThanOrEqual(100);
      expect(call.sql).toContain('INSERT INTO files');
      expect(call.sql).toContain('ON CONFLICT(id) DO NOTHING');
      // Placeholder rows must not set the blob-skip markers.
      expect(call.sql).not.toContain('content_hash');
      expect(call.sql).not.toContain('git_blob_sha');
    }

    const allParams = execCalls.flatMap((c) => c.params);
    for (const row of rows) {
      expect(allParams).toContain(fileIdFor(row.repoId, row.path));
    }
  });

  it('is a no-op for an empty row list', async () => {
    const { d1, execCalls } = fakeD1();
    await ensureFileRows(d1, []);
    expect(execCalls).toHaveLength(0);
  });
});

describe('replaceScipFactsForRepo', () => {
  it('deletes existing facts then batches symbol inserts at 9 rows/statement', async () => {
    const { d1, execCalls } = fakeD1();
    const symbols = Array.from({ length: 20 }, (_, i) => scipSymbol(`sym${i}`));
    await replaceScipFactsForRepo(d1, 'acme/widget', symbols, []);

    const deletes = execCalls.filter((c) => c.sql.includes('DELETE FROM'));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.sql).toContain('scip_references');
    expect(deletes[1]!.sql).toContain('scip_symbols');

    const symbolInserts = execCalls.filter((c) => c.sql.includes('INSERT INTO scip_symbols'));
    // 11 bound params/row * 9 rows/statement = 99 <= 100; 20 rows -> 3 statements.
    expect(symbolInserts).toHaveLength(3);
    expect(symbolInserts[0]!.params).toHaveLength(9 * 11);
    expect(symbolInserts[1]!.params).toHaveLength(9 * 11);
    expect(symbolInserts[2]!.params).toHaveLength(2 * 11);
    for (const call of symbolInserts) {
      expect(call.params.length).toBeLessThanOrEqual(100);
      expect(call.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    }

    const allParams = symbolInserts.flatMap((c) => c.params);
    for (const s of symbols) {
      expect(allParams).toContain(s.id);
    }
  });

  it('batches reference inserts at 11 rows/statement', async () => {
    const { d1, execCalls } = fakeD1();
    const references = Array.from({ length: 23 }, (_, i) => scipReference(`ref${i}`, `sym${i}`));
    await replaceScipFactsForRepo(d1, 'acme/widget', [], references);

    const refInserts = execCalls.filter((c) => c.sql.includes('INSERT INTO scip_references'));
    // 9 bound params/row * 11 rows/statement = 99 <= 100; 23 rows -> 3 statements.
    expect(refInserts).toHaveLength(3);
    expect(refInserts[0]!.params).toHaveLength(11 * 9);
    expect(refInserts[1]!.params).toHaveLength(11 * 9);
    expect(refInserts[2]!.params).toHaveLength(1 * 9);
    for (const call of refInserts) {
      expect(call.params.length).toBeLessThanOrEqual(100);
      expect(call.sql).toContain('ON CONFLICT(id) DO NOTHING');
    }
  });

  it('is a no-op insert-wise (beyond the deletes) for empty input', async () => {
    const { d1, execCalls } = fakeD1();
    await replaceScipFactsForRepo(d1, 'acme/widget', [], []);
    expect(execCalls).toHaveLength(2); // only the two blanket deletes
  });
});
