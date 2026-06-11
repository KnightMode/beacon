/**
 * Slack message builders for CI-failure triage posts.
 *
 * The plain `text` field carries the full content, not just a fallback: the
 * :rocket: reaction flow reads the reacted message's `text` (never blocks)
 * as the create-PR issue hint, and resolveTargetRepo parses the repo out of
 * it — the run's github.com URL near the top is what makes that resolution
 * unambiguous (a bare `owner/repo` regex could match a file path instead).
 */

import type { Citation, TriageJob } from '@scintel/shared';
import { buildCitationBlocks, truncate, type SlackBlock } from '../format.js';

export interface TriageMessage {
  text: string;
  blocks: SlackBlock[];
}

const ROCKET_CTA = 'React with :rocket: to have me draft a fix PR.';

function header(job: TriageJob): string {
  return (
    `:rotating_light: CI failure in ${job.repoFullName} — ` +
    `*${job.workflowName}* on \`${job.headBranch}\` (\`${job.headSha.slice(0, 7)}\`)`
  );
}

export function buildTriageMessage(
  job: TriageJob,
  analysis: string,
  citations: Citation[],
): TriageMessage {
  const text = [header(job), job.runHtmlUrl, '', analysis, '', ROCKET_CTA].join(
    '\n',
  );

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:rotating_light: *CI failure* in \`${job.repoFullName}\` — ` +
          `<${job.runHtmlUrl}|${job.workflowName} #${job.runId}> ` +
          `on \`${job.headBranch}\` (\`${job.headSha.slice(0, 7)}\`)`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(analysis, 2800) },
    },
    ...buildCitationBlocks(citations, analysis),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:rocket: ${ROCKET_CTA}` },
    },
  ];

  return { text, blocks };
}

export function buildTransientMessage(
  job: TriageJob,
  reason: string,
): TriageMessage {
  const note =
    `Looks *likely transient* (${reason}) — probably not caused by the code. ` +
    'Consider re-running the workflow.';
  const text = [
    `:warning: CI failure in ${job.repoFullName} — *${job.workflowName}* on \`${job.headBranch}\``,
    job.runHtmlUrl,
    '',
    note,
    '',
    `${ROCKET_CTA} (only if you think it is a real bug)`,
  ].join('\n');

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:warning: *CI failure* in \`${job.repoFullName}\` — ` +
          `<${job.runHtmlUrl}|${job.workflowName} #${job.runId}> ` +
          `on \`${job.headBranch}\`\n${note}`,
      },
    },
  ];

  return { text, blocks };
}
