/**
 * GitHub webhook event handling. Supports `installation`,
 * `installation_repositories`, and `push`.
 *
 * Incremental indexing semantics (documented): on push we collect the set of
 * added/modified files and the set of removed files across the push's commits.
 * The indexer applies "delete-old-then-reindex": for every changed file it
 * deletes the file's existing chunks + vectors, then re-chunks and re-embeds
 * the current content; removed files just have their chunks/vectors deleted.
 */

import { shouldIndexFile } from '@scintel/shared';
import type { Env } from './env.js';
import {
  upsertRepo,
  getTenantSelectionsForInstallationRepo,
  revokeRepoFromInstallationTenants,
  disableInstallationAllowlist,
  isRepoInUse,
  purgeRepoIndex,
  isAllowlisted,
  repoIdFor,
  upsertInstallationRepoGrant,
} from './db.js';
import {
  enqueueFullIndex,
  enqueueIncrementalIndex,
  enqueueTriage,
} from './jobs.js';

interface GithubRepoLite {
  id?: number;
  full_name: string;
  default_branch?: string;
  private?: boolean;
}

interface InstallationPayload {
  action: string;
  installation?: {
    id?: number;
    account?: {
      login?: string;
      type?: string;
    };
  };
  repositories?: GithubRepoLite[];
  repositories_added?: GithubRepoLite[];
  repositories_removed?: GithubRepoLite[];
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository: GithubRepoLite & { default_branch?: string };
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

export interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    run_attempt?: number;
    conclusion: string | null;
    name: string;
    head_branch: string;
    head_sha: string;
    html_url: string;
  };
  repository: GithubRepoLite;
}

export async function handleWebhookEvent(
  env: Env,
  event: string,
  payload: unknown,
  ctx?: ExecutionContext,
): Promise<Response> {
  switch (event) {
    case 'ping':
      return json({ ok: true, pong: true });
    case 'installation':
    case 'installation_repositories':
      return handleInstallation(env, payload as InstallationPayload, ctx);
    case 'push':
      return handlePush(env, payload as PushPayload);
    case 'workflow_run':
      return handleWorkflowRun(env, payload as WorkflowRunPayload);
    default:
      return json({ ok: true, ignored: event });
  }
}

async function handleInstallation(
  env: Env,
  payload: InstallationPayload,
  ctx?: ExecutionContext,
): Promise<Response> {
  const installationId = payload.installation?.id;
  const removedRepos = payload.action === 'deleted'
    ? (payload.repositories ?? [])
    : (payload.repositories_removed ?? []);
  const revoked: string[] = [];
  const purged: string[] = [];
  for (const r of removedRepos) {
    const repoId = repoIdFor(r.full_name);
    await revokeRepoFromInstallationTenants(env, installationId, repoId);
    await disableInstallationAllowlist(env, repoId);
    revoked.push(r.full_name);

    // When nothing references the repo anymore, drop its indexed data from
    // Cloudflare (D1 rows + Vectorize vectors) so removed repos don't linger.
    if (!(await isRepoInUse(env, repoId))) {
      const cleanup = (async () => {
        // Re-check at execution time: a quick remove→re-add re-enables the
        // repo and re-indexes it, so a stale background purge must back off.
        if (await isRepoInUse(env, repoId)) return;
        const res = await purgeRepoIndex(env, repoId);
        console.log('purged repo index', { repo: r.full_name, vectors: res.vectors });
      })().catch((err) =>
        console.error('repo index purge failed', {
          repo: r.full_name,
          error: (err as Error).message,
        }),
      );
      if (ctx?.waitUntil) ctx.waitUntil(cleanup);
      else await cleanup;
      purged.push(r.full_name);
    }
  }

  const repos = [
    ...(payload.action === 'deleted' ? [] : (payload.repositories ?? [])),
    ...(payload.repositories_added ?? []),
  ];
  const enqueued: string[] = [];
  for (const r of repos) {
    const repoId = await upsertRepo(env, {
      githubId: r.id ?? null,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
    });
    await upsertInstallationRepoGrant(env, installationId, repoId, {
      githubId: r.id ?? null,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
    });
    const selections = await getTenantSelectionsForInstallationRepo(env, installationId, repoId);
    for (const selection of selections) {
      await enqueueFullIndex(
        env,
        repoId,
        r.full_name,
        undefined,
        selection.tenantId,
        selection.installationId,
      );
    }
    enqueued.push(r.full_name);
  }
  return json({ ok: true, action: payload.action, enqueued, revoked, purged });
}

async function handlePush(env: Env, payload: PushPayload): Promise<Response> {
  const repo = payload.repository;
  const repoId = repoIdFor(repo.full_name);
  const installationId = (payload as { installation?: { id?: number } }).installation?.id;

  // Only index pushes to the default branch for the MVP.
  const defaultBranch = repo.default_branch ?? 'main';
  if (payload.ref && payload.ref !== `refs/heads/${defaultBranch}`) {
    return json({ ok: true, ignored: 'non-default-branch', ref: payload.ref });
  }

  const changed = new Set<string>();
  const removed = new Set<string>();
  for (const c of payload.commits ?? []) {
    for (const f of c.added ?? []) changed.add(f);
    for (const f of c.modified ?? []) changed.add(f);
    for (const f of c.removed ?? []) removed.add(f);
  }
  // A removed-then-readded file should count as changed.
  for (const f of changed) removed.delete(f);

  // Only files the indexer would actually index should cost a pipeline run —
  // pushes touching just lockfiles, CI configs, binaries, etc. are ignored.
  for (const f of changed) {
    if (!shouldIndexFile(f).include) changed.delete(f);
  }
  for (const f of removed) {
    if (!shouldIndexFile(f).include) removed.delete(f);
  }
  if (changed.size === 0 && removed.size === 0) {
    return json({ ok: true, ignored: 'no-indexable-changes', repo: repo.full_name });
  }

  await upsertRepo(env, {
    githubId: repo.id ?? null,
    fullName: repo.full_name,
    defaultBranch,
    private: repo.private,
  });

  const selections = await getTenantSelectionsForInstallationRepo(env, installationId, repoId);
  if (selections.length > 0) {
    for (const selection of selections) {
      await enqueueIncrementalIndex(
        env,
        repoId,
        repo.full_name,
        [...changed],
        [...removed],
        payload.after,
        selection.tenantId,
        selection.installationId,
      );
    }
  } else if (!installationId && (await isAllowlisted(env, repoId))) {
    await enqueueIncrementalIndex(
      env,
      repoId,
      repo.full_name,
      [...changed],
      [...removed],
      payload.after,
    );
  } else {
    return json({ ok: true, ignored: 'not-selected-for-tenant', repo: repo.full_name });
  }

  return json({
    ok: true,
    repo: repo.full_name,
    changed: changed.size,
    removed: removed.size,
    enqueued: selections.length || 1,
  });
}

/**
 * Pure filter for workflow_run events: returns a skip reason, or null when
 * the run should be triaged. Failures on any branch qualify; the pipeline
 * dispatch repo is excluded so the indexing workflow's own failures don't
 * loop back through triage.
 */
export function workflowRunSkipReason(
  payload: WorkflowRunPayload,
  pipelineDispatchRepo: string | undefined,
): string | null {
  if (payload.action !== 'completed') return 'not-completed';
  if (payload.workflow_run.conclusion !== 'failure') return 'not-failure';
  if (
    pipelineDispatchRepo &&
    payload.repository.full_name.toLowerCase() ===
      pipelineDispatchRepo.toLowerCase()
  ) {
    return 'pipeline-repo';
  }
  return null;
}

async function handleWorkflowRun(
  env: Env,
  payload: WorkflowRunPayload,
): Promise<Response> {
  const skip = workflowRunSkipReason(payload, env.PIPELINE_DISPATCH_REPO);
  if (skip) return json({ ok: true, ignored: skip });

  const fullName = payload.repository.full_name;
  if (!(await isAllowlisted(env, repoIdFor(fullName)))) {
    return json({ ok: true, ignored: 'not-allowlisted', repo: fullName });
  }

  await enqueueTriage(env, payload);
  return json({
    ok: true,
    repo: fullName,
    enqueued: true,
    runId: payload.workflow_run.id,
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
