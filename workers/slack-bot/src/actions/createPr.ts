/**
 * Create a GitHub pull request from a Slack issue description (thread or message).
 */

import type { Env } from '../env.js';
import { repoIdFor } from '@scintel/shared';
import { GitHubClient } from '../github.js';
import { resolveTargetRepo } from '../repoTarget.js';
import { retrieve } from '../retrieval/pipeline.js';
import {
  applyEdits,
  generatePrProposal,
  guessTargetPaths,
  type PrFileChange,
  type PrProposal,
} from '../llm/createPr.js';
import { call } from '../stream.js';
import { buildIssueFromThread } from '../slackApi.js';
import { fetchThreadHistory } from '../history.js';
import type { AssistantMessage } from '../assistant.js';
import { enqueueCreatePr, type CreatePrJob } from '../jobs/createPrQueue.js';
import { createStagedPrPlan, needsStagedPrPlan } from './stagedPrPlan.js';

const CREATE_LOADING = [
  'Reading the issue…',
  'Searching indexed code…',
  'Drafting changes…',
  'Opening pull request on GitHub…',
];

const MAX_FILE_BYTES = 30_000;

export function createPrMissingPatMessage(): string {
  return (
    'Creating pull requests needs GitHub App write access for this repo. ' +
    'Reconnect the workspace GitHub App with *Contents: Write* and *Pull requests: Write*.'
  );
}

export interface CreatePrTarget {
  channel: string;
  threadTs: string;
  userId?: string;
  teamId?: string;
  messageTs?: string;
  /** Primary issue text when not using full thread (e.g. @mention body). */
  issueHint?: string;
}

/** Enqueue create-PR (Slack event handlers — must finish within waitUntil limits). */
export async function createPrFromThread(
  env: Env,
  target: CreatePrTarget,
): Promise<void> {
  try {
    await enqueueCreatePr(env, target);
  } catch (err) {
    console.error('create-pr enqueue failed', { error: (err as Error).message });
    await postPlain(
      env,
      target.channel,
      target.threadTs,
      `:warning: Could not start pull request: ${(err as Error).message}`,
    );
  }
}

/** Queue consumer entrypoint. */
export async function processCreatePrJob(env: Env, job: CreatePrJob): Promise<void> {
  await runCreatePr(env, job);
}

/** Assistant pane: enqueue create PR from message + thread context. */
export async function handleAssistantCreatePr(
  env: Env,
  m: AssistantMessage,
): Promise<void> {
  await createPrFromThread(env, {
    channel: m.channelId,
    threadTs: m.threadTs,
    userId: m.userId,
    teamId: m.teamId,
    messageTs: m.messageTs,
    issueHint: m.text,
  });
}

async function runCreatePr(env: Env, target: CreatePrTarget): Promise<void> {
  const log = (step: string, extra: Record<string, unknown> = {}): void => {
    console.log('create-pr', { step, channel: target.channel, threadTs: target.threadTs, ...extra });
  };

  try {
    await call(env, 'assistant.threads.setStatus', {
      channel_id: target.channel,
      thread_ts: target.threadTs,
      status: 'is opening a pull request…',
      loading_messages: CREATE_LOADING,
    }, target.teamId).catch(() => undefined);

    log('start');

    const historyPromise = fetchThreadHistory(
      env,
      target.channel,
      target.threadTs,
      target.messageTs,
      target.teamId,
    ).catch(() => []);
    const threadIssuePromise = buildIssueFromThread(env, target.channel, target.threadTs, target.teamId);
    const [history, threadIssue] = await Promise.all([historyPromise, threadIssuePromise]);
    const issue = target.issueHint?.trim() || threadIssue;
    if (!issue) {
      await postPlain(
        env,
        target.channel,
        target.threadTs,
        'Describe the issue in this thread first, then react with :pr: or :rocket: to open a pull request.',
        target.teamId,
      );
      return;
    }

    const repo = await resolveTargetRepo(env, issue, target.teamId);
    if (!repo) {
      await postPlain(
        env,
        target.channel,
        target.threadTs,
        'No target repository found. Set `DEFAULT_PR_REPO` on the worker or mention `owner/repo` in the issue.',
        target.teamId,
      );
      return;
    }

    log('repo-resolved', { repo: repo.fullName });

    const gh = await GitHubClient.forTenantRepo(env, target.teamId, repo.fullName);
    if (!gh) {
      await postPlain(env, target.channel, target.threadTs, createPrMissingPatMessage(), target.teamId);
      return;
    }

    const indexedContextPromise = fetchIndexedContext(env, issue, repo.fullName, target.teamId);
    const branchPromise = gh.getDefaultBranchSha(repo.owner, repo.repo);
    const [{ defaultBranch }, indexedContext] = await Promise.all([
      branchPromise,
      indexedContextPromise,
    ]);
    log('context-ready', { contextChars: indexedContext.length });

    if (needsStagedPrPlan(issue, indexedContext)) {
      const plan = await createStagedPrPlan(env, {
        tenantId: target.teamId,
        repoId: repoIdFor(repo.fullName),
        repoFullName: repo.fullName,
        channel: target.channel,
        threadTs: target.threadTs,
        userId: target.userId,
        issue,
      });
      await postPlain(env, target.channel, target.threadTs, plan.summary, target.teamId);
      log('staged-plan-created', { planId: plan.id, repo: repo.fullName });
      return;
    }

    const targetPaths = guessTargetPaths(issue, indexedContext, repo.fullName);
    const pathsToLoad = new Set(targetPaths);
    if (/\b(docs?|eli5|explain|readme)\b/i.test(issue)) {
      pathsToLoad.add('README.md');
    }
    const fileSnippets = (
      await Promise.all(
        [...pathsToLoad].map(async (path) => {
          const content = await gh.getFileContent(
            repo.owner,
            repo.repo,
            path,
            defaultBranch,
          );
          return content ? { path, content } : null;
        }),
      )
    ).filter((f): f is { path: string; content: string } => f !== null);
    log('files-loaded', { paths: fileSnippets.map((f) => f.path), repo: repo.fullName });

    const proposal = await generatePrProposal(
      env,
      repo.fullName,
      issue,
      indexedContext,
      fileSnippets,
      history,
    );
    log('proposal-ready', {
      edits: proposal.edits.length,
      files: proposal.files.length,
      branch: proposal.branch,
    });

    const fileChanges = await resolveProposalFiles(
      gh,
      repo.owner,
      repo.repo,
      defaultBranch,
      proposal,
    );

    if (fileChanges.length === 0) {
      await postPlain(
        env,
        target.channel,
        target.threadTs,
        proposal.body || 'Could not propose file changes for this issue. Please add more detail.',
        target.teamId,
      );
      return;
    }

    for (const f of fileChanges) {
      if (new TextEncoder().encode(f.content).length > MAX_FILE_BYTES) {
        throw new Error(`File ${f.path} exceeds size limit`);
      }
    }

    const pr = await gh.createPullRequestFromChanges(
      repo.owner,
      repo.repo,
      proposal.branch,
      proposal.title,
      proposal.body,
      fileChanges,
    );
    log('pr-opened', { number: pr.number, url: pr.htmlUrl });

    await postPlain(
      env,
      target.channel,
      target.threadTs,
      `:white_check_mark: Opened pull request <${pr.htmlUrl}|#${pr.number}: ${proposal.title}>`,
      target.teamId,
    );
  } catch (err) {
    const message = (err as Error).message;
    log('failed', { error: message });
    await postPlain(
      env,
      target.channel,
      target.threadTs,
      `:warning: Could not create pull request: ${message}`,
      target.teamId,
    );
  } finally {
    await clearThreadStatus(env, target.channel, target.threadTs, target.teamId);
  }
}

async function clearThreadStatus(
  env: Env,
  channel: string,
  threadTs: string,
  teamId?: string,
): Promise<void> {
  await call(env, 'assistant.threads.setStatus', {
    channel_id: channel,
    thread_ts: threadTs,
    status: '',
  }, teamId).catch(() => undefined);
}

async function resolveProposalFiles(
  gh: GitHubClient,
  owner: string,
  repo: string,
  defaultBranch: string,
  proposal: PrProposal,
): Promise<PrFileChange[]> {
  if (proposal.files.length > 0) return proposal.files;
  if (proposal.edits.length === 0) return [];

  const byPath = new Map<string, typeof proposal.edits>();
  for (const edit of proposal.edits) {
    const list = byPath.get(edit.path) ?? [];
    list.push(edit);
    byPath.set(edit.path, list);
  }

  const out: PrFileChange[] = [];
  for (const [path, edits] of byPath) {
    const base = await gh.getFileContent(owner, repo, path, defaultBranch);
    if (base === null) {
      throw new Error(`File not found on ${defaultBranch}: ${path}`);
    }
    out.push({ path, content: applyEdits(base, edits) });
  }
  return out;
}

async function fetchIndexedContext(
  env: Env,
  issue: string,
  repoFullName: string,
  teamId?: string,
): Promise<string> {
  const query = `${repoFullName} implement fix: ${issue}`;
  try {
    const outcome = await retrieve(env, query, query, teamId);
    if (outcome.packed.used.length === 0) return '';
    return outcome.packed.contextText.slice(0, 10_000);
  } catch {
    return '';
  }
}

async function postPlain(
  env: Env,
  channel: string,
  threadTs: string,
  text: string,
  teamId?: string,
): Promise<void> {
  await call(env, 'chat.postMessage', { channel, thread_ts: threadTs, text }, teamId);
}

/** Slash command helper text when create_pr intent is detected. */
export function createPrSlashAck(): string {
  return ':rocket: Describe the issue in a thread and react with :pr: to open a PR, or @mention the bot with `create pr: <issue>`.';
}
