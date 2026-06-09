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
        text: 'Answered from indexed repository content. Verify before relying on it.',
      },
    ],
  });

  return {
    response_type: 'in_channel',
    text: truncate(answer, 2800),
    blocks,
  };
}

function formatCitations(citations: Citation[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of citations) {
    const ref = `${c.repoFullName}/${c.path}:${c.startLine}-${c.endLine}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    lines.push(`• \`${ref}\``);
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
