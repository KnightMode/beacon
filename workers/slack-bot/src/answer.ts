/**
 * Non-streaming answer builder: retrieval -> LLM -> formatted Slack message.
 * Shared by the slash command (response_url) and the streaming fallback path.
 */

import type { Env } from './env.js';
import { retrieveSmart } from './retrieval/pipeline.js';
import { generateAnswer } from './llm.js';
import { buildRetrievalText, type Turn } from './history.js';
import { buildAnswerMessage, type SlackMessage } from './format.js';
import { userFacingAiError } from './workersAi.js';

export interface BuildAnswerResult {
  message: SlackMessage;
  hadCitations: boolean;
}

export async function buildAnswer(
  env: Env,
  question: string,
  history: Turn[] = [],
  onProgress?: (stage: string) => void,
  teamId?: string,
): Promise<BuildAnswerResult> {
  try {
    const searchText = buildRetrievalText(history, question);
    const outcome = await retrieveSmart(env, question, searchText, onProgress, teamId);
    onProgress?.('is drafting a grounded answer…');
    const answer = await generateAnswer(env, question, outcome.packed, history);
    const citations = outcome.packed.citations;
    return {
      message: buildAnswerMessage(question, answer.text, citations),
      hadCitations: citations.length > 0,
    };
  } catch (err) {
    return {
      message: buildAnswerMessage(
        question,
        userFacingAiError(err),
        [],
      ),
      hadCitations: false,
    };
  }
}
