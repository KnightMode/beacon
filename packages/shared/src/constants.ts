/**
 * Shared constants: chunk types, edge types, indexing statuses, job types,
 * and the file ignore / extension maps used across all components.
 */

export const CHUNK_TYPES = {
  FUNCTION: 'function',
  METHOD: 'method',
  CLASS: 'class',
  STRUCT: 'struct',
  TYPE: 'type',
  INTERFACE: 'interface',
  IMPORT: 'import',
  CALL: 'call',
  MARKDOWN_SECTION: 'markdown_section',
  GENERIC: 'generic',
} as const;
export type ChunkType = (typeof CHUNK_TYPES)[keyof typeof CHUNK_TYPES];

export const EDGE_TYPES = {
  IMPORTS: 'IMPORTS',
  CALLS: 'CALLS',
} as const;
export type EdgeType = (typeof EDGE_TYPES)[keyof typeof EDGE_TYPES];

export const INDEX_STATUS = {
  PENDING: 'PENDING',
  INDEXING: 'INDEXING',
  READY: 'READY',
  FAILED: 'FAILED',
} as const;
export type IndexStatus = (typeof INDEX_STATUS)[keyof typeof INDEX_STATUS];

export const JOB_TYPES = {
  FULL_INDEX: 'FULL_INDEX',
  INCREMENTAL_INDEX: 'INCREMENTAL_INDEX',
} as const;
export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/** Default model ids; overridable via env vars in every component. */
export const DEFAULT_EMBEDDING_MODEL = '@cf/google/embeddinggemma-300m';
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_LLM_MODEL = '@cf/moonshotai/kimi-k2.6';

/** Retrieval / chunking tuning knobs. */
export const MAX_CHUNK_CHARS = 8_000;
export const MAX_CONTEXT_CHUNKS = 12;
export const SLACK_TIMESTAMP_SKEW_SECONDS = 60 * 5;

/** Directory names that are always skipped during indexing. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.git',
  '.svn',
  '.hg',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  'Pods',
  'bower_components',
]);

/** Exact filenames to skip (lockfiles, etc.). */
export const IGNORED_FILENAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
  '.ds_store',
]);

/** Extensions to skip (binaries, images, archives, minified, media). */
export const IGNORED_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tiff', 'psd',
  // media
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'webm',
  // archives / binaries
  'zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'jar', 'war', 'exe', 'dll',
  'so', 'dylib', 'a', 'o', 'class', 'wasm', 'bin', 'dat', 'pdf',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // misc
  'lock', 'map',
]);

/**
 * Map of file extension -> canonical language name.
 * Tree-sitter parsing supports go / typescript / javascript / python; markdown
 * is heading-chunked; everything else may be skipped or simple-chunked.
 */
export const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  go: 'go',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  // recognized but treated as generic for the MVP:
  java: 'java',
  rb: 'ruby',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  sql: 'sql',
  txt: 'text',
};

/** Languages that have a tree-sitter grammar wired up in the indexer. */
export const TREE_SITTER_LANGUAGES: ReadonlySet<string> = new Set([
  'go',
  'typescript',
  'javascript',
  'python',
]);
