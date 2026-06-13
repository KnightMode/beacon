import { handleError, json, requireSession } from '../../../_lib/admin.js';
import { queryWorkspaceChannels } from '../../../_lib/slack.js';

export async function onRequestGet(context) {
  try {
    const session = await requireSession(context);
    const url = new URL(context.request.url);
    const result = await queryWorkspaceChannels(context.env, session.tenantId, {
      q: url.searchParams.get('q') || '',
      limit: Number(url.searchParams.get('limit') || 50),
      cursor: url.searchParams.get('cursor') || undefined,
    });
    return json(result);
  } catch (err) {
    return handleError(err);
  }
}
