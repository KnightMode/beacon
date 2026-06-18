import { describe, expect, it } from 'vitest';
import {
  buildAnswerMessage,
  buildCitationBlocks,
  formatAnswerDuration,
} from '../src/format.js';

describe('answer duration formatting', () => {
  it('formats sub-minute durations compactly', () => {
    expect(formatAnswerDuration(450)).toBe('<1s');
    expect(formatAnswerDuration(2400)).toBe('2.4s');
    expect(formatAnswerDuration(12_400)).toBe('12s');
  });

  it('formats minute-scale durations', () => {
    expect(formatAnswerDuration(65_200)).toBe('1m 5s');
    expect(formatAnswerDuration(120_000)).toBe('2m');
  });

  it('adds answered-in timing to answer footers', () => {
    const message = buildAnswerMessage('question', 'answer', [], {
      answeredInMs: 2400,
    });

    expect(JSON.stringify(message.blocks)).toContain('Answered in 2.4s');
  });

  it('does not add timing when no answer duration is provided', () => {
    const blocks = buildCitationBlocks([], 'answer');

    expect(JSON.stringify(blocks)).not.toContain('Answered in');
  });

  it('does not list sources when the answer cites no markers', () => {
    const blocks = buildCitationBlocks(
      [
        {
          repoFullName: 'KnightMode/beacon',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 2,
        },
      ],
      "I couldn't find that in the indexed repositories.",
    );

    expect(JSON.stringify(blocks)).not.toContain('*Sources*');
  });

  it('lists only sources cited by answer markers', () => {
    const blocks = buildCitationBlocks(
      [
        {
          repoFullName: 'KnightMode/beacon',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 2,
        },
        {
          repoFullName: 'KnightMode/beacon',
          path: 'src/b.ts',
          startLine: 3,
          endLine: 4,
        },
      ],
      'The relevant behavior is here [2].',
    );
    const text = JSON.stringify(blocks);

    expect(text).not.toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
  });
});
