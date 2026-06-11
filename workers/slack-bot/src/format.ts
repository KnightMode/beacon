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

  blocks.push(...buildCitationBlocks(citations, answer));

  return {
    response_type: 'in_channel',
    text: truncate(answer, 2800),
    blocks,
  };
}

/** [n] markers actually referenced in the answer text. */
export function citedMarkers(answerText: string): Set<number> {
  const cited = new Set<number>();
  for (const m of answerText.matchAll(/\[(\d{1,2})\]/g)) {
    cited.add(Number(m[1]));
  }
  return cited;
}

/**
 * Citation + disclaimer blocks, shared by the non-streaming message and the
 * finalized streamed message (rendered at the bottom via chat.stopStream).
 * When the answer text is provided, only the sources the answer actually
 * cites are listed (retrieval noise the LLM ignored is dropped); original
 * [n] numbering is preserved.
 */
export function buildCitationBlocks(
  citations: Citation[],
  answerText?: string,
): SlackBlock[] {
  let entries = citations.map((c, idx) => ({ c, n: idx + 1 }));
  if (answerText) {
    const cited = citedMarkers(answerText);
    if (cited.size > 0) {
      entries = entries.filter((e) => cited.has(e.n));
    }
  }

  const blocks: SlackBlock[] = [];
  if (entries.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Sources*\n${formatCitations(entries)}` },
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
  // Permalink to the indexed commit; HEAD resolves to the default branch
  // (whatever its name) when the sha is unavailable.
  const ref = c.commitSha || 'HEAD';
  return `https://github.com/${c.repoFullName}/blob/${ref}/${path}#L${c.startLine}-L${c.endLine}`;
}

function formatCitations(entries: Array<{ c: Citation; n: number }>): string {
  return entries
    .map(({ c, n }) => {
      const repoName = c.repoFullName.split('/')[1] ?? c.repoFullName;
      const label = `${repoName}/${c.path}:${c.startLine}-${c.endLine}`;
      return `\`[${n}]\` <${githubUrl(c)}|${label}>`;
    })
    .join('\n');
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

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
