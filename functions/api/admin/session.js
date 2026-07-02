import { handleError, json, readSession, rememberAdminEmail, tenantSummary } from '../../_lib/admin.js';

export async function onRequestGet(context) {
  try {
    const session = await readSession(context);
    if (!session?.tenantId) return json({ authenticated: false });
    // Keep the Access email -> tenant mapping fresh so the workspace session
    // survives cookie expiry (readSession falls back to this mapping).
    if (session.via !== 'access') await rememberAdminEmail(context, session.tenantId);
    return json({ authenticated: true, ...(await tenantSummary(context.env, session.tenantId)) });
  } catch (err) {
    return handleError(err);
  }
}
