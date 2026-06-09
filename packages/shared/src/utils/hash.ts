/**
 * Content hashing utilities. Uses the Web Crypto API (`crypto.subtle`), which
 * is available both in Cloudflare Workers and Node.js >= 20, so the same code
 * runs everywhere.
 */

const encoder = new TextEncoder();

/** SHA-256 hex digest of a string. */
export async function sha256Hex(input: string): Promise<string> {
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(digest);
}

/** Stable id for a chunk derived from its identifying coordinates. */
export async function chunkId(
  repoId: string,
  path: string,
  chunkType: string,
  startLine: number,
  endLine: number,
  symbol: string | null,
): Promise<string> {
  return sha256Hex(
    [repoId, path, chunkType, startLine, endLine, symbol ?? ''].join('\u0000'),
  );
}

/** Stable id for an edge derived from its endpoints. */
export async function edgeId(
  repoId: string,
  edgeType: string,
  fromNodeId: string,
  toNodeId: string,
  startLine: number | null,
): Promise<string> {
  return sha256Hex(
    [repoId, edgeType, fromNodeId, toNodeId, startLine ?? ''].join('\u0000'),
  );
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}
