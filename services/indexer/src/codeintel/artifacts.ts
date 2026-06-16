/**
 * External code-intelligence artifact generation.
 *
 * Heavy Zoekt / SCIP work runs in the Node indexer process (GitHub Actions in
 * production), never in request-path Workers. This module records artifacts and
 * optionally imports normalized SCIP facts into D1 so the Slack worker can use
 * them during retrieval.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CODE_INDEX_ARTIFACT_STATUS,
  CODE_INDEX_ARTIFACT_TYPES,
  SCIP_REFERENCE_ROLES,
  SCIP_SYMBOL_KINDS,
  type CodeIndexArtifact,
  type ScipReference,
  type ScipReferenceRole,
  type ScipSymbol,
  type ScipSymbolKind,
} from '@scintel/shared';
import type { IndexerConfig } from '../config.js';
import type { D1Client } from '../cloudflare/d1.js';
import {
  replaceScipFactsForRepo,
  upsertCodeIndexArtifact,
} from '../core/store.js';
import { log } from '../logger.js';

export interface CodeIntelInput {
  d1: D1Client;
  config: IndexerConfig;
  repoId: string;
  repoFullName: string;
  commitSha: string;
  files: Map<string, string>;
}

export interface CodeIntelResult {
  artifactsWritten: number;
  scipSymbols: number;
  scipReferences: number;
}

interface CommandSpec {
  name?: string;
  command: string;
  args?: string[];
  language?: string;
  output?: string;
}

export function shouldRunCodeIntel(config: IndexerConfig): boolean {
  return config.codeIntel.mode !== 'off';
}

export async function runCodeIntelArtifacts(
  input: CodeIntelInput,
): Promise<CodeIntelResult> {
  if (!shouldRunCodeIntel(input.config)) {
    return { artifactsWritten: 0, scipSymbols: 0, scipReferences: 0 };
  }
  if (input.files.size === 0) {
    log.info('no repository file snapshot available; skipping code-intel artifacts', {
      repo: input.repoFullName,
      commitSha: input.commitSha,
    });
    return { artifactsWritten: 0, scipSymbols: 0, scipReferences: 0 };
  }

  const root = await mkdtemp(path.join(input.config.codeIntel.workDir ?? tmpdir(), 'beacon-codeintel-'));
  try {
    const repoDir = path.join(root, 'repo');
    await materializeRepo(repoDir, input.files);

    let artifactsWritten = 0;
    const zoekt = await maybeRunZoekt(input, repoDir, root);
    artifactsWritten += zoekt ? 1 : 0;

    const scip = await maybeRunScip(input, repoDir);
    artifactsWritten += scip.artifactsWritten;

    return {
      artifactsWritten,
      scipSymbols: scip.scipSymbols,
      scipReferences: scip.scipReferences,
    };
  } catch (err) {
    if (input.config.codeIntel.mode === 'required') throw err;
    log.warn('code-intel artifacts failed; continuing because mode is best_effort', {
      repo: input.repoFullName,
      error: (err as Error).message,
    });
    return { artifactsWritten: 0, scipSymbols: 0, scipReferences: 0 };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function maybeRunZoekt(
  input: CodeIntelInput,
  repoDir: string,
  root: string,
): Promise<boolean> {
  const shardPrefix = zoektShardPrefix(input.repoId);
  const outDir = input.config.codeIntel.zoektIndexDir ?? path.join(root, 'zoekt-index');
  await mkdir(outDir, { recursive: true });
  await removeExistingZoektShards(outDir, shardPrefix);

  const metaPath = path.join(root, `${shardPrefix}.meta.json`);
  await writeFile(metaPath, `${JSON.stringify(zoektRepositoryMeta(input), null, 2)}\n`, 'utf8');

  const args = [
    '-index',
    outDir,
    '-shard_prefix_override',
    shardPrefix,
    '-meta',
    metaPath,
    repoDir,
  ];
  const artifactId = artifactIdFor(input.repoId, CODE_INDEX_ARTIFACT_TYPES.ZOEKT_SHARD, input.commitSha);
  try {
    await runCommand(input.config.codeIntel.zoektIndexBin, args, repoDir);
    const contentHash = await hashZoektShards(outDir, shardPrefix);
    await upsertCodeIndexArtifact(input.d1, {
      id: artifactId,
      repoId: input.repoId,
      artifactType: CODE_INDEX_ARTIFACT_TYPES.ZOEKT_SHARD,
      status: CODE_INDEX_ARTIFACT_STATUS.READY,
      commitSha: input.commitSha,
      language: null,
      producer: `zoekt:${input.config.codeIntel.zoektIndexBin}`,
      artifactUri: zoektArtifactUri(input.config, input.repoId, outDir),
      contentHash,
      metadataJson: JSON.stringify({ indexDir: outDir, shardPrefix }),
      error: null,
    });
    return true;
  } catch (err) {
    await upsertCodeIndexArtifact(input.d1, failedArtifact(
      input,
      artifactId,
      CODE_INDEX_ARTIFACT_TYPES.ZOEKT_SHARD,
      `zoekt:${input.config.codeIntel.zoektIndexBin}`,
      err,
    ));
    if (input.config.codeIntel.mode === 'required') throw err;
    return false;
  }
}

async function maybeRunScip(
  input: CodeIntelInput,
  repoDir: string,
): Promise<CodeIntelResult> {
  const commands = parseCommands(input.config.codeIntel.scipCommandsJson);
  let artifactsWritten = 0;

  for (const command of commands) {
    const artifactId = artifactIdFor(
      input.repoId,
      CODE_INDEX_ARTIFACT_TYPES.SCIP_INDEX,
      input.commitSha,
      command.language,
    );
    try {
      await runCommand(command.command, command.args ?? [], repoDir);
      const output = path.resolve(repoDir, command.output ?? 'index.scip');
      const contentHash = await hashFileIfExists(output);
      await upsertCodeIndexArtifact(input.d1, {
        id: artifactId,
        repoId: input.repoId,
        artifactType: CODE_INDEX_ARTIFACT_TYPES.SCIP_INDEX,
        status: CODE_INDEX_ARTIFACT_STATUS.READY,
        commitSha: input.commitSha,
        language: command.language ?? null,
        producer: command.name ?? command.command,
        artifactUri: artifactUri(
          input.config,
          input.repoId,
          input.commitSha,
          command.language ? `scip/${command.language}` : 'scip',
          output,
        ),
        contentHash,
        metadataJson: JSON.stringify({ command }),
        error: null,
      });
      artifactsWritten++;
    } catch (err) {
      await upsertCodeIndexArtifact(input.d1, failedArtifact(
        input,
        artifactId,
        CODE_INDEX_ARTIFACT_TYPES.SCIP_INDEX,
        command.name ?? command.command,
        err,
        command.language,
      ));
      if (input.config.codeIntel.mode === 'required') throw err;
    }
  }

  const factsPath = input.config.codeIntel.scipFactsPath
    ? path.resolve(repoDir, input.config.codeIntel.scipFactsPath)
    : path.join(repoDir, 'scip-facts.json');
  const facts =
    (await readNormalizedScipFacts(factsPath, input.repoId, input.commitSha)) ??
    (await buildScipCompatibleFactsFromChunks(input.d1, input.repoId, input.commitSha));
  if (facts) {
    await replaceScipFactsForRepo(input.d1, input.repoId, facts.symbols, facts.references);
    await upsertCodeIndexArtifact(input.d1, {
      id: artifactIdFor(input.repoId, CODE_INDEX_ARTIFACT_TYPES.SCIP_SYMBOLS, input.commitSha),
      repoId: input.repoId,
      artifactType: CODE_INDEX_ARTIFACT_TYPES.SCIP_SYMBOLS,
      status: CODE_INDEX_ARTIFACT_STATUS.READY,
      commitSha: input.commitSha,
      language: null,
      producer: 'beacon-normalized-scip',
      artifactUri: artifactUri(input.config, input.repoId, input.commitSha, 'scip/facts', factsPath),
      contentHash: await hashFileIfExists(factsPath),
      metadataJson: JSON.stringify({
        symbols: facts.symbols.length,
        references: facts.references.length,
      }),
      error: null,
    });
    artifactsWritten++;
    return {
      artifactsWritten,
      scipSymbols: facts.symbols.length,
      scipReferences: facts.references.length,
    };
  }

  return { artifactsWritten, scipSymbols: 0, scipReferences: 0 };
}

interface ChunkFactRow {
  id: string;
  repo_id: string;
  path: string;
  language: string | null;
  chunk_type: string;
  symbol: string | null;
  start_line: number;
  end_line: number;
  commit_sha: string | null;
}

interface EdgeFactRow {
  id: string;
  repo_id: string;
  from_node_id: string;
  to_symbol: string | null;
  start_line: number | null;
}

async function buildScipCompatibleFactsFromChunks(
  d1: D1Client,
  repoId: string,
  commitSha: string,
): Promise<NormalizedFacts | null> {
  const chunks = await d1.query<ChunkFactRow>(
    `SELECT id, repo_id, path, language, chunk_type, symbol, start_line, end_line, commit_sha
     FROM chunks
     WHERE repo_id = ?1
       AND symbol IS NOT NULL
       AND chunk_type IN ('function','method','class','struct','type','interface')`,
    [repoId],
  );
  if (chunks.length === 0) return null;

  const symbols: ScipSymbol[] = chunks.map((c) => ({
    id: stableId(repoId, c.id, 'symbol'),
    repoId,
    symbol: c.symbol!,
    displayName: c.symbol,
    kind: chunkTypeToSymbolKind(c.chunk_type),
    language: c.language,
    path: c.path,
    startLine: c.start_line,
    endLine: c.end_line,
    definitionChunkId: c.id,
    commitSha: c.commit_sha ?? commitSha,
  }));

  const byName = new Map<string, ScipSymbol[]>();
  for (const symbol of symbols) {
    const list = byName.get(symbol.displayName ?? symbol.symbol) ?? [];
    list.push(symbol);
    byName.set(symbol.displayName ?? symbol.symbol, list);
  }

  const edges = await d1.query<EdgeFactRow>(
    `SELECT id, repo_id, from_node_id, to_symbol, start_line
     FROM code_edges
     WHERE repo_id = ?1 AND edge_type = 'CALLS' AND to_symbol IS NOT NULL`,
    [repoId],
  );
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const references: ScipReference[] = [];
  for (const edge of edges) {
    const targets = edge.to_symbol ? byName.get(edge.to_symbol) ?? [] : [];
    const from = chunkById.get(edge.from_node_id);
    if (!from || targets.length === 0) continue;
    for (const target of targets.slice(0, 3)) {
      references.push({
        id: stableId(repoId, edge.id, target.id, edge.start_line ?? from.start_line),
        repoId,
        symbolId: target.id,
        role: SCIP_REFERENCE_ROLES.REFERENCE,
        path: from.path,
        startLine: edge.start_line ?? from.start_line,
        endLine: edge.start_line ?? from.start_line,
        enclosingSymbol: from.symbol,
        commitSha: from.commit_sha ?? commitSha,
      });
    }
  }

  return { symbols, references };
}

function chunkTypeToSymbolKind(chunkType: string): ScipSymbolKind {
  switch (chunkType) {
    case 'class':
      return SCIP_SYMBOL_KINDS.CLASS;
    case 'interface':
      return SCIP_SYMBOL_KINDS.INTERFACE;
    case 'struct':
    case 'type':
      return SCIP_SYMBOL_KINDS.TYPE;
    case 'method':
      return SCIP_SYMBOL_KINDS.METHOD;
    case 'function':
      return SCIP_SYMBOL_KINDS.FUNCTION;
    default:
      return SCIP_SYMBOL_KINDS.UNKNOWN;
  }
}

async function materializeRepo(root: string, files: Map<string, string>): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [repoPath, content] of files) {
    const safe = safeRepoPath(repoPath);
    if (!safe) continue;
    const out = path.join(root, safe);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, content, 'utf8');
  }
}

function parseCommands(raw: string | undefined): CommandSpec[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('SCIP_COMMANDS_JSON must be a JSON array');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`SCIP command ${index} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.command !== 'string' || obj.command.trim() === '') {
      throw new Error(`SCIP command ${index} is missing command`);
    }
    if (obj.args !== undefined && !Array.isArray(obj.args)) {
      throw new Error(`SCIP command ${index} args must be an array`);
    }
    return {
      name: typeof obj.name === 'string' ? obj.name : undefined,
      command: obj.command,
      args: Array.isArray(obj.args) ? obj.args.map(String) : [],
      language: typeof obj.language === 'string' ? obj.language : undefined,
      output: typeof obj.output === 'string' ? obj.output : undefined,
    };
  });
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

interface NormalizedFacts {
  symbols: ScipSymbol[];
  references: ScipReference[];
}

async function readNormalizedScipFacts(
  factsPath: string,
  repoId: string,
  commitSha: string,
): Promise<NormalizedFacts | null> {
  let raw: string;
  try {
    raw = await readFile(factsPath, 'utf8');
  } catch {
    return null;
  }

  const parsed = JSON.parse(raw) as {
    symbols?: unknown[];
    references?: unknown[];
  };
  const symbols = (parsed.symbols ?? []).map((s, i) =>
    normalizeSymbol(s, i, repoId, commitSha),
  );
  const knownSymbols = new Set(symbols.map((s) => s.id));
  const references = (parsed.references ?? [])
    .map((r, i) => normalizeReference(r, i, repoId, commitSha))
    .filter((r) => knownSymbols.has(r.symbolId));
  return { symbols, references };
}

function normalizeSymbol(
  raw: unknown,
  index: number,
  repoId: string,
  commitSha: string,
): ScipSymbol {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`SCIP symbol ${index} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const symbol = requiredString(obj.symbol, `SCIP symbol ${index}.symbol`);
  const pathValue = requiredString(obj.path, `SCIP symbol ${index}.path`);
  const startLine = requiredNumber(obj.startLine ?? obj.start_line, `SCIP symbol ${index}.startLine`);
  const endLine = requiredNumber(obj.endLine ?? obj.end_line ?? startLine, `SCIP symbol ${index}.endLine`);
  return {
    id: optionalString(obj.id) ?? stableId(repoId, symbol, pathValue, startLine, endLine),
    repoId,
    symbol,
    displayName: optionalString(obj.displayName ?? obj.display_name),
    kind: symbolKind(optionalString(obj.kind)),
    language: optionalString(obj.language),
    path: pathValue,
    startLine,
    endLine,
    definitionChunkId: optionalString(obj.definitionChunkId ?? obj.definition_chunk_id),
    commitSha,
  };
}

function normalizeReference(
  raw: unknown,
  index: number,
  repoId: string,
  commitSha: string,
): ScipReference {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`SCIP reference ${index} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const symbolId = requiredString(obj.symbolId ?? obj.symbol_id, `SCIP reference ${index}.symbolId`);
  const pathValue = requiredString(obj.path, `SCIP reference ${index}.path`);
  const startLine = requiredNumber(obj.startLine ?? obj.start_line, `SCIP reference ${index}.startLine`);
  const endLine = requiredNumber(obj.endLine ?? obj.end_line ?? startLine, `SCIP reference ${index}.endLine`);
  const role = referenceRole(optionalString(obj.role));
  return {
    id: optionalString(obj.id) ?? stableId(repoId, symbolId, role, pathValue, startLine, endLine),
    repoId,
    symbolId,
    role,
    path: pathValue,
    startLine,
    endLine,
    enclosingSymbol: optionalString(obj.enclosingSymbol ?? obj.enclosing_symbol),
    commitSha,
  };
}

function failedArtifact(
  input: CodeIntelInput,
  id: string,
  artifactType: CodeIndexArtifact['artifactType'],
  producer: string,
  err: unknown,
  language?: string,
): CodeIndexArtifact {
  return {
    id,
    repoId: input.repoId,
    artifactType,
    status: CODE_INDEX_ARTIFACT_STATUS.FAILED,
    commitSha: input.commitSha,
    language: language ?? null,
    producer,
    artifactUri: null,
    contentHash: null,
    metadataJson: null,
    error: (err as Error).message,
  };
}

function artifactIdFor(
  repoId: string,
  type: CodeIndexArtifact['artifactType'],
  commitSha: string,
  language = '',
): string {
  return `${repoId}:${commitSha}:${type}:${language || 'all'}`;
}

function artifactUri(
  config: IndexerConfig,
  repoId: string,
  commitSha: string,
  kind: string,
  localPath: string,
): string {
  const base = config.codeIntel.artifactBaseUri?.replace(/\/+$/, '');
  if (!base) return localPath;
  return `${base}/${encodeURIComponent(repoId)}/${commitSha}/${kind}`;
}

function zoektArtifactUri(config: IndexerConfig, repoId: string, localPath: string): string {
  const base = config.codeIntel.artifactBaseUri?.replace(/\/+$/, '');
  if (!base) return localPath;
  return `${base}/${zoektShardPrefix(repoId)}`;
}

function zoektShardPrefix(repoId: string): string {
  return repoId.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function zoektRepositoryMeta(input: CodeIntelInput): Record<string, unknown> {
  return {
    ID: zoektRepositoryId(input.repoId),
    Name: input.repoId,
    URL: `https://github.com/${input.repoFullName}`,
    Branches: [{ Name: 'HEAD', Version: input.commitSha }],
    Metadata: {
      repo_id: input.repoId,
      full_name: input.repoFullName,
    },
  };
}

function zoektRepositoryId(repoId: string): number {
  const digest = createHash('sha256').update(repoId).digest();
  const id = digest.readUInt32BE(0);
  return id === 0 ? 1 : id;
}

async function hashFileIfExists(file: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch {
    return null;
  }
}

async function hashZoektShards(dir: string, shardPrefix: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = (await readdir(dir))
    .filter((entry) => entry.startsWith(`${shardPrefix}_`) && entry.endsWith('.zoekt'))
    .sort();
  for (const entry of entries) {
    hash.update(entry);
    hash.update(await readFile(path.join(dir, entry)));
  }
  return hash.digest('hex');
}

async function removeExistingZoektShards(dir: string, shardPrefix: string): Promise<void> {
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${shardPrefix}_`) && entry.endsWith('.zoekt'))
      .map((entry) => rm(path.join(dir, entry), { force: true })),
  );
}

function safeRepoPath(repoPath: string): string | null {
  const normalized = path.posix.normalize(repoPath.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function requiredString(value: unknown, label: string): string {
  const out = optionalString(value);
  if (!out) throw new Error(`${label} is required`);
  return out;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function requiredNumber(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`);
  return n;
}

function symbolKind(value: string | null): ScipSymbolKind {
  const set = new Set(Object.values(SCIP_SYMBOL_KINDS));
  return value && set.has(value as ScipSymbolKind) ? (value as ScipSymbolKind) : SCIP_SYMBOL_KINDS.UNKNOWN;
}

function referenceRole(value: string | null): ScipReferenceRole {
  const set = new Set(Object.values(SCIP_REFERENCE_ROLES));
  return value && set.has(value as ScipReferenceRole)
    ? (value as ScipReferenceRole)
    : SCIP_REFERENCE_ROLES.REFERENCE;
}

function stableId(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}
