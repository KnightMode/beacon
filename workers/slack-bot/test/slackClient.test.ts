import { afterEach, describe, expect, it, vi } from 'vitest';
import { slackGet, slackPostJson } from '../src/slackClient.js';

describe('slackClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends authenticated GET requests with encoded Slack parameters', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, messages: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await slackGet(
      { SLACK_BOT_TOKEN: 'xoxb-test' } as never,
      'conversations.replies',
      { channel: 'C 1', ts: '123.456', inclusive: true, limit: 1 },
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const parsed = new URL(String(url));
    expect(result.ok).toBe(true);
    expect(parsed.pathname).toBe('/api/conversations.replies');
    expect(parsed.searchParams.get('channel')).toBe('C 1');
    expect(parsed.searchParams.get('inclusive')).toBe('true');
    expect(parsed.searchParams.get('limit')).toBe('1');
    expect(init?.headers).toEqual({ authorization: 'Bearer xoxb-test' });
  });

  it('sends JSON POST requests and normalizes non-2xx responses', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response('rate limited', { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await slackPostJson(
      { SLACK_BOT_TOKEN: 'xoxb-test' } as never,
      'chat.postMessage',
      { channel: 'C1', text: 'hello' },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer xoxb-test',
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: 'C1', text: 'hello' }),
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'http_429:rate limited',
    });
  });
});
