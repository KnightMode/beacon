/**
 * PR review action: fetch diff from GitHub, optionally enrich with indexed
 * context, generate a structured review, and post it to Slack.
 */

import type { Env } from '../env.js';
import { GitHubClient } from '../github.js';
import { parsePrReference } from '../intent.js';
import { retrieve } from '../retrieval/pipeline.js';
import { generatePrReview, streamPrReviewTokens } from '../llm/review.js';
import { buildPrReviewMessage, buildPrReviewStreamFooter } from '../format.js';
import { call, type StreamTarget } from '../stream.js';
import { fetchThreadHistory } from '../history.js';
import type { AssistantMessage } from '../assistant.js';

const MAX_FILES = 20;
const MAX_PATCH_CHARS = 2_400;
const FLUSH_CHARS = 90;

const REVIEW_LOADING = [
  'Fetching pull request…',
  'Reading the diff…',
  'Cross-checking indexed code…',
  'Drafting review…',
];

export function prReviewMissingPatMessage(): string {
  return (
    'PR review needs a GitHub token on the slack-bot worker. Run:\n' +
    '`cd workers/slack-bot && npx wrangler secret put GITHUB_PAT`\n' +
    'Use a fine-grained PAT with *Pull requests: Read* and *Contents: Read* ' +
    'on the target repos.'
  );
}

/** Stream a PR review into a channel thread (same UX as Q&A). */
export async function streamPrReview(env: Env, t: StreamTarget): Promise<void> {
  const gh = GitHubClient.fromEnv(env);
  if (!gh) {
    await postPlain(env, t.channel, t.threadTs, prReviewMissingPatMessage());
    return;
  }

  const ref = parsePrReference(t.question);
  if (!ref) {
    await postPlain(
      env,
      t.channel,
      t.threadTs,
      'Could not parse a PR reference. Try:\n' +
        '`review https://github.com/owner/repo/pull/123` or `review owner/repo#123`',
    );
    return;
  }

  await call(env, 'assistant.threads.setStatus', {
    channel_id: t.channel,
    thread_ts: t.threadTs,
    status: 'is reviewing…',
    loading_messages: REVIEW_LOADING,
  }).catch(() => undefined);

  const history = await fetchThreadHistory(
    env,
    t.channel,
    t.threadTs,
    t.messageTs,
  ).catch(() => []);

  try {
    const ctx = await buildPrContext(env, gh, ref);
    let ts: string | undefined;

    const write = async (text: string): Promise<void> => {
      if (!ts) {
        const started = await call(env, 'chat.startStream', {
          channel: t.channel,
          thread_ts: t.threadTs,
          recipient_user_id: t.userId,
          recipient_team_id: t.teamId,
          chunks: [{ type: 'markdown_text', text }],
        });
        if (!started.ok || !started.ts) {
          throw new Error(`startStream: ${started.error ?? 'unknown'}`);
        }
        ts = started.ts;
      } else {
        await call(env, 'chat.appendStream', {
          channel: t.channel,
          ts,
          chunks: [{ type: 'markdown_text', text }],
        });
      }
    };

    let buffer = '';
    let streamedAny = false;
    const flush = async (): Promise<void> => {
      if (!buffer) return;
      await write(buffer);
      buffer = '';
    };

    for await (const token of streamPrReviewTokens(
      env,
      ctx.prSummary,
      ctx.diffContext,
      ctx.indexedContext,
      history,
    )) {
      streamedAny = true;
      buffer += token;
      if (buffer.length >= FLUSH_CHARS) await flush();
    }
    await flush();

    if (!streamedAny) {
      await write("I couldn't generate a review from this pull request.");
    }

    await call(env, 'chat.stopStream', {
      channel: t.channel,
      ts,
      blocks: buildPrReviewStreamFooter(ref.url),
    });
  } catch (err) {
    await postPlain(
      env,
      t.channel,
      t.threadTs,
      `:warning: PR review failed: ${(err as Error).message}`,
    );
  }
}

/** PR review for the assistant pane (shimmer → single post). */
export async function handleAssistantPrReview(
  env: Env,
  m: AssistantMessage,
): Promise<void> {
  const gh = GitHubClient.fromEnv(env);
  if (!gh) {
    await call(env, 'chat.postMessage', {
      channel: m.channelId,
      thread_ts: m.threadTs,
      text: prReviewMissingPatMessage(),
    });
    return;
  }

  const ref = parsePrReference(m.text);
  if (!ref) {
    await call(env, 'chat.postMessage', {
      channel: m.channelId,
      thread_ts: m.threadTs,
      text: 'Could not parse a PR reference from your message.',
    });
    return;
  }

  await call(env, 'assistant.threads.setStatus', {
    channel_id: m.channelId,
    thread_ts: m.threadTs,
    status: 'is reviewing…',
    loading_messages: REVIEW_LOADING,
  });

  const history = await fetchThreadHistory(
    env,
    m.channelId,
    m.threadTs,
    m.messageTs,
  ).catch(() => []);

  try {
    const ctx = await buildPrContext(env, gh, ref);
    const review = await generatePrReview(
      env,
      ctx.prSummary,
      ctx.diffContext,
      ctx.indexedContext,
      history,
    );
    const message = buildPrReviewMessage(ref.url, review);
    await call(env, 'chat.postMessage', {
      channel: m.channelId,
      thread_ts: m.threadTs,
      text: message.text,
      blocks: message.blocks,
    });
  } catch (err) {
    await call(env, 'chat.postMessage', {
      channel: m.channelId,
      thread_ts: m.threadTs,
      text: `:warning: PR review failed: ${(err as Error).message}`,
    });
  }
}

/** Non-streaming PR review for slash command response_url. */
export async function reviewToResponseUrl(
  env: Env,
  text: string,
  responseUrl: string,
): Promise<void> {
  const gh = GitHubClient.fromEnv(env);
  if (!gh) {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: prReviewMissingPatMessage(),
      }),
    });
    return;
  }

  const ref = parsePrReference(text);
  if (!ref) {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: 'Could not parse a PR reference.',
      }),
    });
    return;
  }

  try {
    const ctx = await buildPrContext(env, gh, ref);
    const review = await generatePrReview(
      env,
      ctx.prSummary,
      ctx.diffContext,
      ctx.indexedContext,
    );
    const message = buildPrReviewMessage(ref.url, review);
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...message, replace_original: false }),
    });
  } catch (err) {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: `PR review failed: ${(err as Error).message}`,
      }),
    });
  }
}

interface PrContextBundle {
  prSummary: string;
  diffContext: string;
  indexedContext: string;
}

async function buildPrContext(
  env: Env,
  gh: GitHubClient,
  ref: { owner: string; repo: string; number: number; url: string },
): Promise<PrContextBundle> {
  const [pr, files] = await Promise.all([
    gh.getPullRequest(ref.owner, ref.repo, ref.number),
    gh.listPullRequestFiles(ref.owner, ref.repo, ref.number),
  ]);

  const prSummary = [
    `Repo: ${ref.owner}/${ref.repo}`,
    `PR #${pr.number}: ${pr.title}`,
    `URL: ${pr.htmlUrl}`,
    `State: ${pr.state} (${pr.baseRef} ← ${pr.headRef})`,
    `Stats: ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}`,
    pr.body ? `Description:\n${pr.body.slice(0, 2_000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const diffContext = formatDiff(files);
  const indexedContext = await fetchIndexedContext(env, ref, pr, files);

  return { prSummary, diffContext, indexedContext };
}

function formatDiff(files: import('../github.js').PullRequestFile[]): string {
  const shown = files.slice(0, MAX_FILES);
  const blocks: string[] = [];
  for (const f of shown) {
    const header = `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
    const patch = f.patch ? f.patch.slice(0, MAX_PATCH_CHARS) : '(no patch — binary or large file)';
    blocks.push(`${header}\n${patch}`);
  }
  if (files.length > MAX_FILES) {
    blocks.push(`\n… and ${files.length - MAX_FILES} more files not shown`);
  }
  return blocks.join('\n\n');
}

async function fetchIndexedContext(
  env: Env,
  ref: { owner: string; repo: string },
  pr: { title: string },
  files: import('../github.js').PullRequestFile[],
): Promise<string> {
  const paths = files
    .slice(0, 8)
    .map((f) => f.filename)
    .join(' ');
  const query = `${ref.owner}/${ref.repo} PR "${pr.title}" changes in: ${paths}`;
  try {
    const outcome = await retrieve(env, query, query);
    if (outcome.packed.used.length === 0) return '';
    return outcome.packed.contextText.slice(0, 8_000);
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
