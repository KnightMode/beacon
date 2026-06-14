import { getTenantSlackBotToken, HttpError } from './admin.js';
import { slackPostForm } from './slackClient.js';

export async function queryWorkspaceChannels(env, tenantId, options = {}) {
  const token = await getTenantSlackBotToken(env, tenantId);
  if (!token) {
    throw new HttpError(400, 'Connect Slack before listing channels.');
  }

  const q = String(options.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const cursor = options.cursor || undefined;
  const maxPages = 5;
  const channels = [];
  let nextCursor = cursor;
  let hasMore = false;
  let pages = 0;

  while (pages < maxPages && channels.length < limit) {
    const body = await slackApi(token, 'conversations.list', {
      limit: '200',
      exclude_archived: 'true',
      types: 'public_channel,private_channel',
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });

    for (const channel of body.channels ?? []) {
      if (channel.is_archived) continue;
      const name = String(channel.name || '');
      const label = channel.is_private ? `#${name} (private)` : `#${name}`;
      if (q && !name.includes(q) && !channel.id.toLowerCase().includes(q)) continue;
      channels.push({
        id: channel.id,
        name,
        label,
        isPrivate: Boolean(channel.is_private),
        memberCount: channel.num_members ?? null,
      });
      if (channels.length >= limit) break;
    }

    nextCursor = body.response_metadata?.next_cursor || '';
    hasMore = Boolean(nextCursor);
    pages += 1;
    if (!nextCursor || channels.length >= limit) break;
  }

  return {
    channels,
    cursor: hasMore ? nextCursor : null,
    hasMore,
  };
}

async function slackApi(token, method, params) {
  return slackPostForm(method, params, { token });
}
