/**
 * Create a GitHub pull request from a Slack issue description (thread or message).
 */

import type { Env } from '../env.js';
import { GitHubClient } from '../github.js';
import { resolveTargetRepo } from '../repoTarget.js';
import { retrieve } from '../retrieval/pipeline.js';
import { generatePrProposal } from '../llm/createPr.js';
import { call } from '../stream.js';
import { buildIssueFromThread } from '../slackApi.js';
import { fetchThreadHistory } from '../history.js';
import type { AssistantMessage } from '../assistant.js';
import { enqueueCreatePr, type CreatePrJob } from '../jobs/createPrQueue.js';

const CREATE_LOADING = [
  'Reading the issue…',
  'Searching indexed code…',
  'Drafting changes…',
  'Opening pull request on GitHub…',
];

const MAX_FILE_BYTES = 30_000;

export function createPrMissingPatMessage(): string {
  return (
    'Creating pull requests needs a GitHub token with write access. Run:\n' +
    '`cd workers/slack-bot && npx wrangler secret put GITHUB_PAT`\n' +
    'Use a fine-grained PAT with *Contents: Write* and *Pull requests: Write* ' +
    'on the target repos.'
  );
}

export interface CreatePrTarget {
  channel: string;
  threadTs: string;
  userId?: string;
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
    messageTs: m.messageTs,
    issueHint: m.text,
  });
}

async function runCreatePr(env: Env, target: CreatePrTarget): Promise<void> {
  const log = (step: string, extra: Record<string, unknown> = {}): void => {
    console.log('create-pr', { step, channel: target.channel, threadTs: target.threadTs, ...extra });
  };

  try {
    const gh = GitHubClient.fromEnv(env);
    if (!gh) {
      await postPlain(env, target.channel, target.threadTs, createPrMissingPatMessage());
      return;
    }

    await call(env, 'assistant.threads.setStatus', {
      channel_id: target.channel,
      thread_ts: target.threadTs,
      status: 'is opening a pull request…',
      loading_messages: CREATE_LOADING,
    }).catch(() => undefined);

    log('start');

    const history = await fetchThreadHistory(
    env,
    target.channel,
    target.threadTs,
    target.messageTs,
    ).catch(() => []);

    const threadIssue = await buildIssueFromThread(env, target.channel, target.threadTs);
    const issue = target.issueHint?.trim() || threadIssue;
    if (!issue) {
      await postPlain(
        env,
        target.channel,
        target.threadTs,
        'Describe the issue in this thread first, then react with :pr: or :rocket: to open a pull request.',
      );
      return;
    }

    const repo = await resolveTargetRepo(env, issue);
    if (!repo) {
      await postPlain(
        env,
        target.channel,
        target.threadTs,
        'No target repository found. Set `DEFAULT_PR_REPO` on the worker or mention `owner/repo` in the issue.',
      );
      return;
    }

    log('repo-resolved', { repo: repo.fullName });

    const indexedContext = await fetchIndexedContext(env, issue, repo.fullName);
    log('context-ready', { contextChars: indexedContext.length });

    const proposal = await generatePrProposal(
      env,
      repo.fullName,
      issue,
      indexedContext,
      history,
    );
    log('proposal-ready', { files: proposal.files.length, branch: proposal.branch });

    if (proposal.files.length === 0) {
      await postPlain(
        env,
        target.channel,
        target.threadTs,
        proposal.body || 'Could not propose file changes for this issue. Please add more detail.',
      );
      return;
    }

    for (const f of proposal.files) {
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
      proposal.files,
    );
    log('pr-opened', { number: pr.number, url: pr.htmlUrl });

    await postPlain(
      env,
      target.channel,
      target.threadTs,
      `:white_check_mark: Opened pull request <${pr.htmlUrl}|#${pr.number}: ${proposal.title}>`,
    );
  } catch (err) {
    const message = (err as Error).message;
    log('failed', { error: message });
    await postPlain(
      env,
      target.channel,
      target.threadTs,
      `:warning: Could not create pull request: ${message}`,
    );
  } finally {
    await clearThreadStatus(env, target.channel, target.threadTs);
  }
}

async function clearThreadStatus(
  env: Env,
  channel: string,
  threadTs: string,
): Promise<void> {
  await call(env, 'assistant.threads.setStatus', {
    channel_id: channel,
    thread_ts: threadTs,
    status: '',
  }).catch(() => undefined);
}

async function fetchIndexedContext(
  env: Env,
  issue: string,
  repoFullName: string,
): Promise<string> {
  const query = `${repoFullName} implement fix: ${issue}`;
  try {
    const outcome = await retrieve(env, query, query);
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
): Promise<void> {
  await call(env, 'chat.postMessage', { channel, thread_ts: threadTs, text });
}

/** Slash command helper text when create_pr intent is detected. */
export function createPrSlashAck(): string {
  return ':rocket: Describe the issue in a thread and react with :pr: to open a PR, or @mention the bot with `create pr: <issue>`.';
}
