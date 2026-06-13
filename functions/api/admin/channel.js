import { audit, handleError, HttpError, json, markStep, requireSession } from '../../_lib/admin.js';

export async function onRequestPost(context) {
  try {
    const session = await requireSession(context);
    const body = await context.request.json();
    const repoId = String(body.repo || '').trim().toLowerCase();
    const channelId = String(body.channelId || '').trim();
    if (!repoId || !channelId) throw new HttpError(400, 'Repo and channel are required.');

    const row = await context.env.DB.prepare(
      `SELECT repo_id, full_name FROM tenant_repos
       WHERE tenant_id = ?1 AND repo_id = ?2 AND enabled = 1`,
    )
      .bind(session.tenantId, repoId)
      .first();
    if (!row) throw new HttpError(404, 'That repo is not selected for this workspace.');

    await context.env.DB.prepare(
      `INSERT INTO tenant_ci_notify_channels (tenant_id, repo_id, channel_id, added_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, datetime('now'))
       ON CONFLICT(tenant_id, repo_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         added_by = excluded.added_by,
         updated_at = datetime('now')`,
    )
      .bind(session.tenantId, repoId, channelId, session.userId || null)
      .run();
    await markStep(context.env, session.tenantId, 'channel', 'COMPLETE', { channelId });
    await audit(context.env, session.tenantId, session.userId, 'channel.mapped', 'repo', repoId, { channelId });
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
