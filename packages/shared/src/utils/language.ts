/**
 * Language detection by file extension, plus helpers describing which
 * languages can be parsed with tree-sitter vs. heading-chunked vs. skipped.
 */

import {
  EXTENSION_LANGUAGE_MAP,
  TREE_SITTER_LANGUAGES,
} from '../constants.js';

/** Returns the lowercased extension without the dot, or '' if none. */
export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Canonical language name for a path, or null if unknown. */
export function detectLanguage(path: string): string | null {
  const ext = extensionOf(path);
  return EXTENSION_LANGUAGE_MAP[ext] ?? null;
}

export function isTreeSitterLanguage(language: string | null): boolean {
  return language !== null && TREE_SITTER_LANGUAGES.has(language);
}

export function isMarkdown(language: string | null): boolean {
  return language === 'markdown';
}
