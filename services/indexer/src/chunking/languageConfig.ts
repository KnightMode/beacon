/**
 * Per-grammar node-type maps used by the chunker. We walk the syntax tree by
 * node type (rather than compiling tree-sitter queries) to avoid query-compile
 * errors across grammar versions and keep the prototype robust.
 */

import { CHUNK_TYPES, type ChunkType } from '@scintel/shared';
import type { GrammarKey } from './parser.js';

export interface LangSpec {
  /** node.type -> chunk type for definition nodes. */
  definitions: Record<string, ChunkType>;
  /** node types that represent import statements. */
  imports: Set<string>;
  /** node types that represent call expressions. */
  calls: Set<string>;
  /** node types whose presence marks a definition as a "method" (class bodies). */
  classLike: Set<string>;
}

const TS_LIKE: LangSpec = {
  definitions: {
    function_declaration: CHUNK_TYPES.FUNCTION,
    generator_function_declaration: CHUNK_TYPES.FUNCTION,
    method_definition: CHUNK_TYPES.METHOD,
    class_declaration: CHUNK_TYPES.CLASS,
    abstract_class_declaration: CHUNK_TYPES.CLASS,
    interface_declaration: CHUNK_TYPES.INTERFACE,
    type_alias_declaration: CHUNK_TYPES.TYPE,
    enum_declaration: CHUNK_TYPES.TYPE,
  },
  imports: new Set(['import_statement']),
  calls: new Set(['call_expression']),
  classLike: new Set(['class_declaration', 'abstract_class_declaration']),
};

const GO_SPEC: LangSpec = {
  definitions: {
    function_declaration: CHUNK_TYPES.FUNCTION,
    method_declaration: CHUNK_TYPES.METHOD,
    type_spec: CHUNK_TYPES.TYPE, // refined to struct/interface in the chunker
  },
  imports: new Set(['import_spec']),
  calls: new Set(['call_expression']),
  classLike: new Set(),
};

const PYTHON_SPEC: LangSpec = {
  definitions: {
    function_definition: CHUNK_TYPES.FUNCTION, // refined to method inside classes
    class_definition: CHUNK_TYPES.CLASS,
  },
  imports: new Set(['import_statement', 'import_from_statement']),
  calls: new Set(['call']),
  classLike: new Set(['class_definition']),
};

const JAVA_SPEC: LangSpec = {
  definitions: {
    class_declaration: CHUNK_TYPES.CLASS,
    interface_declaration: CHUNK_TYPES.INTERFACE,
    enum_declaration: CHUNK_TYPES.TYPE,
    record_declaration: CHUNK_TYPES.TYPE,
    method_declaration: CHUNK_TYPES.METHOD,
    constructor_declaration: CHUNK_TYPES.METHOD,
  },
  imports: new Set(['import_declaration']),
  calls: new Set(['method_invocation', 'object_creation_expression']),
  classLike: new Set([
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ]),
};

const SPECS: Record<GrammarKey, LangSpec> = {
  go: GO_SPEC,
  java: JAVA_SPEC,
  typescript: TS_LIKE,
  tsx: TS_LIKE,
  javascript: TS_LIKE,
  python: PYTHON_SPEC,
};

export function specFor(key: GrammarKey): LangSpec {
  return SPECS[key];
}
