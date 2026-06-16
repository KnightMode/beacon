/**
 * web-tree-sitter loader. Grammars are loaded lazily from the prebuilt wasm
 * files shipped by `tree-sitter-wasms`, so nothing is parsed (or even loaded)
 * until the first file of a given language is encountered. This keeps the CLI
 * `--help` path free of any wasm initialization.
 *
 * NOTE: we pin web-tree-sitter to the 0.22.x line because the prebuilt grammar
 * wasm files in `tree-sitter-wasms` are built against the tree-sitter 0.20/0.21
 * ABI, which newer web-tree-sitter (0.25+) runtimes refuse to load.
 */

import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { log } from '../logger.js';

const require = createRequire(import.meta.url);

export type TSNode = Parser.SyntaxNode;
export type GrammarKey = 'go' | 'java' | 'typescript' | 'tsx' | 'javascript' | 'python';

const WASM_FILES: Record<GrammarKey, string> = {
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
};

let initialized = false;
const languageCache = new Map<GrammarKey, Parser.Language>();

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
}

async function loadLanguage(key: GrammarKey): Promise<Parser.Language> {
  const cached = languageCache.get(key);
  if (cached) return cached;
  await ensureInit();
  const wasmPath = require.resolve(`tree-sitter-wasms/out/${WASM_FILES[key]}`);
  const language = await Parser.Language.load(wasmPath);
  languageCache.set(key, language);
  return language;
}

/** Returns a Parser configured for the given grammar, or null on failure. */
export async function getParser(key: GrammarKey): Promise<Parser | null> {
  try {
    const language = await loadLanguage(key);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  } catch (err) {
    log.warn('failed to load tree-sitter grammar', {
      grammar: key,
      error: (err as Error).message,
    });
    return null;
  }
}

/** Maps a file path + canonical language to a grammar key, if supported. */
export function grammarKeyFor(
  path: string,
  language: string | null,
): GrammarKey | null {
  if (language === 'go') return 'go';
  if (language === 'java') return 'java';
  if (language === 'python') return 'python';
  if (language === 'javascript') return 'javascript';
  if (language === 'typescript') {
    return path.endsWith('.tsx') ? 'tsx' : 'typescript';
  }
  return null;
}
