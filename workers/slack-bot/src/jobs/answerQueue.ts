/**
 * Queue-backed Q&A. waitUntil work is cancelled ~30s after the response is
 * sent, which can kill agentic retrieval + answer streaming mid-flight; queue
 * consumers get minutes. The event handlers ack Slack immediately and enqueue
 * one of these jobs; the consumer does the actual answering. Falls back to
 * direct execution when the queue binding is absent (local dev).
 */

import type { Env } from '../env.js';
import { streamAnswer } from '../stream.js';
import { buildAnswer } from '../answer.js';
import { answerAssistantQuestion } from '../assistant.js';

export type AnswerJob =
  | {
      kind: 'stream';
      channel: string;
      threadTs: string;
      question: string;
      userId?: string;
      teamId?: string;
      messageTs?: string;
    }
  | {
      kind: 'response_url';
      question: string;
      responseUrl: string;
    }
  | {
      kind: 'assistant';
      channelId: string;
      threadTs: string;
      text: string;
      userId?: string;
      teamId?: string;
      messageTs?: string;
    };

/** Enqueue when possible; otherwise run inline (caller wraps in waitUntil). */
export async function enqueueAnswer(env: Env, job: AnswerJob): Promise<void> {
  if (env.ANSWER_QUEUE) {
    await env.ANSWER_QUEUE.send(job);
    return;
  }
  await processAnswerJob(env, job);
}

export async function processAnswerJob(env: Env, job: AnswerJob): Promise<void> {
  switch (job.kind) {
    case 'stream':
      await streamAnswer(env, {
        channel: job.channel,
        threadTs: job.threadTs,
        userId: job.userId,
        teamId: job.teamId,
        question: job.question,
        messageTs: job.messageTs,
      });
      return;
    case 'response_url': {
      const message = await buildAnswer(env, job.question);
      await fetch(job.responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...message, replace_original: false }),
      });
      return;
    }
    case 'assistant':
      await answerAssistantQuestion(env, {
        channelId: job.channelId,
        threadTs: job.threadTs,
        text: job.text,
        userId: job.userId,
        teamId: job.teamId,
        messageTs: job.messageTs,
      });
      return;
  }
}
