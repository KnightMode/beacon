/**
 * Non-streaming answer builder: retrieval -> LLM -> formatted Slack message.
 * Shared by the slash command (response_url) and the streaming fallback path.
 */

import type { Env } from './env.js';
import { retrieve } from './retrieval/pipeline.js';
import { generateAnswer } from './llm.js';
import { buildAnswerMessage, type SlackMessage } from './format.js';

export async function buildAnswer(env: Env, question: string): Promise<SlackMessage> {
  try {
    const outcome = await retrieve(env, question);
    const answer = await generateAnswer(env, question, outcome.packed);
    return buildAnswerMessage(question, answer.text, outcome.packed.citations);
  } catch (err) {
    return buildAnswerMessage(
      question,
      `Sorry — something went wrong answering that: ${(err as Error).message}`,
      [],
    );
  }
}
