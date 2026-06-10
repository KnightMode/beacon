/**
 * Slack message formatting (Block Kit + mrkdwn) for the final answer, including
 * a citations section listing repo/path:start-end.
 */

import type { Citation } from '@scintel/shared';

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}

export interface SlackMessage {
  response_type: 'in_channel' | 'ephemeral';
  text: string;
  blocks: SlackBlock[];
}

export function buildAnswerMessage(
  question: string,
  answer: string,
  citations: Citation[],
): SlackMessage {
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Q:* ${truncate(question, 280)}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(answer, 2800) },
    },
  ];

  blocks.push(...buildCitationBlocks(citations));

  return {
    response_type: 'in_channel',
    text: truncate(answer, 2800),
    blocks,
  };
}

/**
 * Citation + disclaimer blocks, shared by the non-streaming message and the
 * finalized streamed message (rendered at the bottom via chat.stopStream).
 */
export function buildCitationBlocks(citations: Citation[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (citations.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Sources*\n${formatCitations(citations)}` },
    });
  }
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: ':robot_face: Answered from indexed repository content — verify before relying on it.',
      },
    ],
  });
  return blocks;
}

function githubUrl(c: Citation): string {
  const path = c.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${c.repoFullName}/blob/main/${path}#L${c.startLine}-L${c.endLine}`;
}

function formatCitations(citations: Citation[]): string {
  const lines: string[] = [];
  citations.forEach((c, idx) => {
    const label = `${c.path}:${c.startLine}-${c.endLine}`;
    lines.push(`\`[${idx + 1}]\` <${githubUrl(c)}|${label}>`);
  });
  return lines.join('\n');
}

export function buildPrReviewMessage(prUrl: string, review: string): SlackMessage {
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*PR Review:* <${prUrl}|${prUrl}>`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(review, 2800) },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':mag: Generated from the PR diff and indexed repo context — verify before acting on it.',
        },
      ],
    },
  ];

  return {
    response_type: 'in_channel',
    text: truncate(review, 2800),
    blocks,
  };
}

export function buildPrReviewStreamFooter(prUrl: string): SlackBlock[] {
  return [
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `<${prUrl}|View pull request> · :mag: Review from diff + indexed context`,
        },
      ],
    },
  ];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
