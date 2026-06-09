/**
 * File filtering / ignore-list logic used by the indexer to decide which files
 * from a repo tree should be chunked and embedded.
 */

import {
  IGNORED_DIRECTORIES,
  IGNORED_EXTENSIONS,
  IGNORED_FILENAMES,
} from '../constants.js';
import { extensionOf } from './language.js';

/** Hard cap: skip files larger than this many bytes (default 1 MiB). */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export interface FileFilterResult {
  include: boolean;
  reason?: string;
}

/**
 * Decide whether a repo file path should be indexed.
 * `sizeBytes` is optional; when provided, oversized files are skipped.
 */
export function shouldIndexFile(
  path: string,
  sizeBytes?: number,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES,
): FileFilterResult {
  const normalized = path.replace(/^\.?\//, '');
  const segments = normalized.split('/');
  const filename = (segments.pop() ?? '').toLowerCase();

  for (const segment of segments) {
    if (IGNORED_DIRECTORIES.has(segment)) {
      return { include: false, reason: `ignored directory: ${segment}` };
    }
  }

  if (IGNORED_FILENAMES.has(filename)) {
    return { include: false, reason: `ignored filename: ${filename}` };
  }

  // Skip hidden dotfiles except a small set of useful ones.
  if (filename.startsWith('.') && !ALLOWED_DOTFILES.has(filename)) {
    return { include: false, reason: `hidden file: ${filename}` };
  }

  const ext = extensionOf(filename);
  if (ext && IGNORED_EXTENSIONS.has(ext)) {
    return { include: false, reason: `ignored extension: .${ext}` };
  }

  if (isMinified(filename)) {
    return { include: false, reason: 'minified asset' };
  }

  if (sizeBytes !== undefined && sizeBytes > maxBytes) {
    return { include: false, reason: `too large: ${sizeBytes} bytes` };
  }

  return { include: true };
}

const ALLOWED_DOTFILES: ReadonlySet<string> = new Set([
  '.env.example',
  '.gitignore',
  '.dockerignore',
]);

function isMinified(filename: string): boolean {
  return (
    filename.endsWith('.min.js') ||
    filename.endsWith('.min.css') ||
    filename.endsWith('.bundle.js')
  );
}

/** Quick binary sniff: NUL byte within the first chunk means binary. */
export function looksBinary(content: string): boolean {
  const sample = content.slice(0, 8000);
  return sample.includes('\u0000');
}
