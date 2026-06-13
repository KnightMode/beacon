import { handleError, json, requireSession, tenantSummary } from '../../_lib/admin.js';

export async function onRequestGet(context) {
  try {
    const session = await requireSession(context);
    return json(await tenantSummary(context.env, session.tenantId));
  } catch (err) {
    return handleError(err);
  }
}
