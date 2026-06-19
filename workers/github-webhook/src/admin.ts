/**
 * Dev-only admin endpoint: POST /admin/index  (Authorization: Bearer <ADMIN_TOKEN>)
 *
 * Lets the legacy local/non-tenant path work without tenant GitHub App webhooks:
 * it upserts the repo, adds it to the allowlist, and enqueues a FULL_INDEX job.
 *
 * Body: { "repo": "owner/name", "commitSha"?: "..." }
 */

import type { Env } from './env.js';
import { upsertRepo, addToAllowlist } from './db.js';
import { enqueueFullIndex } from './jobs.js';
import { json } from './webhook.js';
import { timingSafeEqual } from './signature.js';

export async function handleAdminIndex(
  env: Env,
  request: Request,
): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env.ADMIN_TOKEN}`;
  if (!env.ADMIN_TOKEN || !timingSafeEqual(auth, expected)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let body: { repo?: string; commitSha?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid JSON body' }, 400);
  }

  const repoFullName = body.repo?.trim();
  if (!repoFullName || !repoFullName.includes('/')) {
    return json({ ok: false, error: 'expected { repo: "owner/name" }' }, 400);
  }

  const repoId = await upsertRepo(env, { fullName: repoFullName });
  await addToAllowlist(env, repoId, repoFullName, 'admin');
  await enqueueFullIndex(env, repoId, repoFullName, body.commitSha);

  return json({ ok: true, enqueued: repoFullName, repoId });
}
