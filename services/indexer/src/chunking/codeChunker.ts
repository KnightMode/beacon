/**
 * Tree-sitter based code chunker. Extracts semantic chunks (functions, methods,
 * classes, structs, types, interfaces), an aggregated import chunk, and the
 * IMPORTS / CALLS graph edges for a single source file.
 */

import {
  CHUNK_TYPES,
  EDGE_TYPES,
  type ChunkType,
  type CodeChunk,
  type CodeEdge,
  chunkId,
  edgeId,
  sha256Hex,
  MAX_CHUNK_CHARS,
} from '@scintel/shared';
import { getParser, grammarKeyFor, type GrammarKey, type TSNode } from './parser.js';
import { specFor, type LangSpec } from './languageConfig.js';

export interface ChunkFileInput {
  repoId: string;
  fileId: string;
  path: string;
  language: string | null;
  content: string;
  commitSha: string | null;
}

export interface ChunkFileResult {
  chunks: CodeChunk[];
  edges: CodeEdge[];
}

/** Returns true if the file's language has a wired-up tree-sitter grammar. */
export function canTreeSit(path: string, language: string | null): boolean {
  return grammarKeyFor(path, language) !== null;
}

export async function chunkCode(
  input: ChunkFileInput,
): Promise<ChunkFileResult | null> {
  const key = grammarKeyFor(input.path, input.language);
  if (!key) return null;

  const parser = await getParser(key);
  if (!parser) return null;

  const tree = parser.parse(input.content);
  if (!tree) return null;

  const spec = specFor(key);
  const chunks: CodeChunk[] = [];
  const edges: CodeEdge[] = [];

  await collectImports(input, key, tree.rootNode, chunks, edges);
  await walk(input, key, spec, tree.rootNode, false, chunks, edges);

  tree.delete();
  return { chunks, edges };
}

async function walk(
  input: ChunkFileInput,
  key: GrammarKey,
  spec: LangSpec,
  node: TSNode,
  insideClass: boolean,
  chunks: CodeChunk[],
  edges: CodeEdge[],
): Promise<void> {
  for (const child of namedChildren(node)) {
    const defType = spec.definitions[child.type];
    if (defType) {
      await emitDefinition(input, key, spec, child, defType, insideClass, chunks, edges);
      await walk(
        input,
        key,
        spec,
        child,
        insideClass || spec.classLike.has(child.type),
        chunks,
        edges,
      );
    } else {
      await walk(input, key, spec, child, insideClass, chunks, edges);
    }
  }
}

async function emitDefinition(
  input: ChunkFileInput,
  key: GrammarKey,
  spec: LangSpec,
  node: TSNode,
  baseType: ChunkType,
  insideClass: boolean,
  chunks: CodeChunk[],
  edges: CodeEdge[],
): Promise<void> {
  let chunkType = baseType;
  if (key === 'python' && node.type === 'function_definition' && insideClass) {
    chunkType = CHUNK_TYPES.METHOD;
  }
  if (key === 'go' && node.type === 'type_spec') {
    chunkType = refineGoType(node);
  }

  const symbol = node.childForFieldName('name')?.text ?? null;
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  let content = input.content.slice(node.startIndex, node.endIndex);
  if (content.length > MAX_CHUNK_CHARS) content = content.slice(0, MAX_CHUNK_CHARS);

  const isCallable =
    chunkType === CHUNK_TYPES.FUNCTION || chunkType === CHUNK_TYPES.METHOD;
  const calls = isCallable ? collectCalls(spec, node) : [];

  const id = await chunkId(input.repoId, input.path, chunkType, startLine, endLine, symbol);
  const contentHash = await sha256Hex(content);

  chunks.push({
    id,
    repoId: input.repoId,
    fileId: input.fileId,
    path: input.path,
    language: input.language,
    chunkType,
    symbol,
    startLine,
    endLine,
    content,
    contentHash,
    commitSha: input.commitSha,
    imports: [],
    calls,
    redacted: false,
  });

  for (const callee of dedupe(calls)) {
    const eid = await edgeId(input.repoId, EDGE_TYPES.CALLS, id, callee, startLine);
    edges.push({
      id: eid,
      repoId: input.repoId,
      edgeType: EDGE_TYPES.CALLS,
      fromNodeId: id,
      toNodeId: callee,
      fromSymbol: symbol,
      toSymbol: callee,
      fileId: input.fileId,
      startLine,
    });
  }
}

async function collectImports(
  input: ChunkFileInput,
  key: GrammarKey,
  root: TSNode,
  chunks: CodeChunk[],
  edges: CodeEdge[],
): Promise<void> {
  const spec = specFor(key);
  const importNodes: TSNode[] = [];
  findByTypes(root, spec.imports, importNodes);
  if (importNodes.length === 0) return;

  const modules: string[] = [];
  for (const n of importNodes) modules.push(...importModules(n, key));
  const uniqueModules = dedupe(modules.filter(Boolean));
  if (uniqueModules.length === 0) return;

  const first = importNodes[0]!;
  const last = importNodes[importNodes.length - 1]!;
  const startLine = first.startPosition.row + 1;
  const endLine = last.endPosition.row + 1;
  const content = importNodes
    .map((n) => input.content.slice(n.startIndex, n.endIndex))
    .join('\n')
    .slice(0, MAX_CHUNK_CHARS);

  const id = await chunkId(
    input.repoId,
    input.path,
    CHUNK_TYPES.IMPORT,
    startLine,
    endLine,
    null,
  );
  const contentHash = await sha256Hex(content);

  chunks.push({
    id,
    repoId: input.repoId,
    fileId: input.fileId,
    path: input.path,
    language: input.language,
    chunkType: CHUNK_TYPES.IMPORT,
    symbol: null,
    startLine,
    endLine,
    content,
    contentHash,
    commitSha: input.commitSha,
    imports: uniqueModules,
    calls: [],
    redacted: false,
  });

  for (const mod of uniqueModules) {
    const eid = await edgeId(input.repoId, EDGE_TYPES.IMPORTS, input.fileId, mod, startLine);
    edges.push({
      id: eid,
      repoId: input.repoId,
      edgeType: EDGE_TYPES.IMPORTS,
      fromNodeId: input.fileId,
      toNodeId: mod,
      fromSymbol: input.path,
      toSymbol: mod,
      fileId: input.fileId,
      startLine,
    });
  }
}

function refineGoType(typeSpec: TSNode): ChunkType {
  const typeField = typeSpec.childForFieldName('type');
  if (typeField?.type === 'struct_type') return CHUNK_TYPES.STRUCT;
  if (typeField?.type === 'interface_type') return CHUNK_TYPES.INTERFACE;
  return CHUNK_TYPES.TYPE;
}

/** Collect callee names in a definition's body, excluding nested defs. */
function collectCalls(spec: LangSpec, defNode: TSNode): string[] {
  const out: string[] = [];
  const recurse = (node: TSNode): void => {
    for (const child of namedChildren(node)) {
      if (child !== defNode && spec.definitions[child.type]) continue;
      if (spec.calls.has(child.type)) {
        const callee = calleeName(child);
        if (callee) out.push(callee);
      }
      recurse(child);
    }
  };
  recurse(defNode);
  return out;
}

function calleeName(callNode: TSNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  const text = fn.text.trim();
  const lastSegment = text.split('.').pop() ?? text;
  const match = lastSegment.match(/[A-Za-z_$][\w$]*/);
  return match ? match[0] : null;
}

function importModules(node: TSNode, key: GrammarKey): string[] {
  if (key === 'python') {
    const names: TSNode[] = [];
    findByTypes(node, new Set(['dotted_name']), names);
    return names.map((n) => n.text);
  }
  // ts / go: extract the string literal module path
  const strings: TSNode[] = [];
  findByTypes(
    node,
    new Set([
      'string',
      'string_literal',
      'interpreted_string_literal',
      'raw_string_literal',
    ]),
    strings,
  );
  return strings.map((n) => stripQuotes(n.text));
}

function stripQuotes(s: string): string {
  return s.replace(/^[`'"]/, '').replace(/[`'"]$/, '');
}

function findByTypes(
  node: TSNode,
  types: ReadonlySet<string>,
  out: TSNode[],
): void {
  for (const child of namedChildren(node)) {
    if (types.has(child.type)) {
      out.push(child);
      continue; // don't descend into a matched import/string subtree
    }
    findByTypes(child, types, out);
  }
}

function namedChildren(node: TSNode): TSNode[] {
  const out: TSNode[] = [];
  const count = node.namedChildCount;
  for (let i = 0; i < count; i++) {
    const c = node.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
