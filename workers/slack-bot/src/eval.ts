/**
 * Eval endpoint: POST /eval/ask runs the real retrieval + answer pipeline for
 * a single question and returns the raw artifacts (answer text, citations,
 * timings) so the offline eval harness (packages/eval) can score them.
 *
 * Protected by the EVAL_TOKEN secret (Bearer auth); the route does not exist
 * when the secret is unset. It never touches Slack.
 */

import type { Env } from './env.js';
import { retrieveSmart, retrieve } from './retrieval/pipeline.js';
import { generateAnswer } from './llm.js';
import { ackJson } from './slack.js';

interface EvalAskRequest {
  question: string;
  /** Optional enriched search text (defaults to the question). */
  searchText?: string;
  /** Set false to force single-shot retrieval regardless of AGENTIC_RETRIEVAL. */
  agentic?: boolean;
}

export async function handleEvalAsk(
  env: Env,
  request: Request,
): Promise<Response> {
  if (!env.EVAL_TOKEN) {
    return ackJson({ ok: false, error: 'not found' }, 404);
  }
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${env.EVAL_TOKEN}`) {
    return ackJson({ ok: false, error: 'unauthorized' }, 401);
  }

  let body: EvalAskRequest;
  try {
    body = (await request.json()) as EvalAskRequest;
  } catch {
    return ackJson({ ok: false, error: 'invalid JSON' }, 400);
  }
  if (typeof body.question !== 'string' || body.question.trim().length === 0) {
    return ackJson({ ok: false, error: 'question is required' }, 400);
  }

  const startedAt = Date.now();
  const outcome =
    body.agentic === false
      ? await retrieve(env, body.question, body.searchText)
      : await retrieveSmart(env, body.question, body.searchText);
  const retrievalMs = Date.now() - startedAt;

  const answer = await generateAnswer(env, body.question, outcome.packed);
  const llmMs = Date.now() - startedAt - retrievalMs;

  return ackJson({
    ok: true,
    question: body.question,
    answer: answer.text,
    citations: outcome.packed.citations,
    usedChunks: outcome.packed.used.length,
    candidates: outcome.candidates,
    allowlist: outcome.allowlist,
    timings: { retrievalMs, llmMs, totalMs: retrievalMs + llmMs },
  });
}
