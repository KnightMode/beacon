import { describe, it, expect } from 'vitest';
import { chunkCode, canTreeSit } from '../src/chunking/codeChunker.js';

describe('Java chunking', () => {
  it('extracts Java definitions, imports, and calls with tree-sitter', async () => {
    const content = [
      'package demo;',
      '',
      'import java.util.List;',
      '',
      'public class OrderService {',
      '  public Order create(List<String> ids) {',
      '    return new Order(ids.size());',
      '  }',
      '}',
    ].join('\n');

    expect(canTreeSit('src/main/java/demo/OrderService.java', 'java')).toBe(true);

    const result = await chunkCode({
      repoId: 'org/repo',
      fileId: 'org/repo:src/main/java/demo/OrderService.java',
      path: 'src/main/java/demo/OrderService.java',
      language: 'java',
      content,
      commitSha: 'abc123',
    });

    expect(result).not.toBeNull();
    const chunks = result!.chunks;
    const edges = result!.edges;

    expect(chunks.some((c) => c.chunkType === 'import' && c.imports.includes('java.util.List'))).toBe(
      true,
    );
    expect(chunks.some((c) => c.chunkType === 'class' && c.symbol === 'OrderService')).toBe(
      true,
    );
    expect(chunks.some((c) => c.chunkType === 'method' && c.symbol === 'create')).toBe(
      true,
    );
    expect(edges.some((e) => e.edgeType === 'CALLS' && e.toSymbol === 'size')).toBe(true);
    expect(edges.some((e) => e.edgeType === 'CALLS' && e.toSymbol === 'Order')).toBe(true);
  });
});
