import { handleError, json, readSession, tenantSummary } from '../../_lib/admin.js';

export async function onRequestGet(context) {
  try {
    const session = await readSession(context);
    if (!session?.tenantId) return json({ authenticated: false });
    return json({ authenticated: true, ...(await tenantSummary(context.env, session.tenantId)) });
  } catch (err) {
    return handleError(err);
  }
}
