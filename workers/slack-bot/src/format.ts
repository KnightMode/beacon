/**
 * Slack message formatting (Block Kit + mrkdwn) for the final answer, including
 * a citations section listing repo/path:start-end.
 */

import { parseRepoRef, type Citation } from '@scintel/shared';

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

export interface AnswerFooterOptions {
  answeredInMs?: number;
}

export function buildAnswerMessage(
  question: string,
  answer: string,
  citations: Citation[],
  footer: AnswerFooterOptions = {},
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

  blocks.push(...buildCitationBlocks(citations, answer, footer));

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
  footer: AnswerFooterOptions = {},
): SlackBlock[] {
  let entries = citations.map((c, idx) => ({ c, n: idx + 1 }));
  if (answerText) {
    const cited = citedMarkers(answerText);
    entries = entries.filter((e) => cited.has(e.n));
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
        text: answerFooterText(footer),
      },
    ],
  });
  return blocks;
}

function answerFooterText({ answeredInMs }: AnswerFooterOptions): string {
  const duration =
    typeof answeredInMs === 'number'
      ? `Answered in ${formatAnswerDuration(answeredInMs)} · `
      : '';
  return `${duration}:robot_face: Answered from indexed repository content — verify before relying on it.`;
}

export function formatAnswerDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 1) return '<1s';
  if (totalSeconds < 10) return `${roundToTenth(totalSeconds)}s`;
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;

  let minutes = Math.floor(totalSeconds / 60);
  let seconds = Math.round(totalSeconds % 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function roundToTenth(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

function githubUrl(c: Citation): string {
  const path = c.path.split('/').map(encodeURIComponent).join('/');
  const repo = parseRepoRef(c.repoFullName);
  const repoPath = repo
    ? `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
    : c.repoFullName;
  // Permalink to the indexed commit; HEAD resolves to the default branch
  // (whatever its name) when the sha is unavailable.
  const ref = c.commitSha || 'HEAD';
  return `https://github.com/${repoPath}/blob/${ref}/${path}#L${c.startLine}-L${c.endLine}`;
}

function formatCitations(entries: Array<{ c: Citation; n: number }>): string {
  return entries
    .map(({ c, n }) => {
      const repoName = parseRepoRef(c.repoFullName)?.name ?? c.repoFullName;
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
