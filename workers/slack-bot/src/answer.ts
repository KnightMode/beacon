/**
 * Non-streaming answer builder: retrieval -> LLM -> formatted Slack message.
 * Shared by the slash command (response_url) and the streaming fallback path.
 */

import type { Env } from './env.js';
import { retrieveSmart } from './retrieval/pipeline.js';
import { generateAnswer } from './llm.js';
import { buildRetrievalText, type Turn } from './history.js';
import { buildAnswerMessage, type SlackMessage } from './format.js';

export async function buildAnswer(
  env: Env,
  question: string,
  history: Turn[] = [],
  onProgress?: (stage: string) => void,
): Promise<SlackMessage> {
  try {
    const searchText = buildRetrievalText(history, question);
    const outcome = await retrieveSmart(env, question, searchText, onProgress);
    onProgress?.('is drafting a grounded answer…');
    const answer = await generateAnswer(env, question, outcome.packed, history);
    return buildAnswerMessage(question, answer.text, outcome.packed.citations);
  } catch (err) {
    return buildAnswerMessage(
      question,
      `Sorry — something went wrong answering that: ${(err as Error).message}`,
      [],
    );
  }
}
