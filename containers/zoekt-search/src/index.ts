import { Container, getContainer } from '@cloudflare/containers';

export class ZoektContainer extends Container<Env> {
  defaultPort = 6070;
  sleepAfter = '5m';
  enableInternet = true;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    this.envVars = {
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_BUCKET_NAME: env.R2_BUCKET_NAME,
      R2_BUCKET_PREFIX: env.R2_BUCKET_PREFIX || 'zoekt',
      ZOEKT_R2_SYNC_INTERVAL_SECONDS: env.ZOEKT_R2_SYNC_INTERVAL_SECONDS || '60',
    };
  }

  override onStart() {
    console.log('Zoekt container started');
  }

  override onStop(params: { exitCode: number; reason: 'exit' | 'runtime_signal' }) {
    console.log('Zoekt container stopped', params);
  }

  override onError(error: unknown) {
    console.log('Zoekt container error', error);
  }
}

interface Env {
  ZOEKT_CONTAINER: DurableObjectNamespace<ZoektContainer>;
  ZOEKT_SEARCH_TOKEN?: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_BUCKET_PREFIX?: string;
  ZOEKT_R2_SYNC_INTERVAL_SECONDS?: string;
}

interface SearchRequest {
  query?: string;
  repos?: string[];
  limit?: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return forwardToZoekt(request, env, '/healthz');
    }
    if (url.pathname !== '/search') {
      return new Response('not found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }
    if (!authorized(request, env)) {
      return new Response('unauthorized', { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as SearchRequest | null;
    const query = body?.query?.trim();
    const repos = Array.isArray(body?.repos) ? body.repos.filter(isRepoName) : [];
    const limit = clampLimit(body?.limit);
    if (!query || repos.length === 0) {
      return Response.json({ matches: [] });
    }

    const zoektUrl = new URL(request.url);
    zoektUrl.pathname = '/search';
    zoektUrl.search = '';
    zoektUrl.searchParams.set('q', scopedQuery(query, repos));
    zoektUrl.searchParams.set('format', 'json');
    zoektUrl.searchParams.set('num', String(limit));
    zoektUrl.searchParams.set('ctx', '1');

    const container = getContainer(env.ZOEKT_CONTAINER);
    return container.fetch(new Request(zoektUrl, { method: 'GET' }));
  },
};

function forwardToZoekt(request: Request, env: Env, pathname: string): Response | Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  const container = getContainer(env.ZOEKT_CONTAINER);
  return container.fetch(new Request(url, { method: 'GET' }));
}

function authorized(request: Request, env: Env): boolean {
  const token = env.ZOEKT_SEARCH_TOKEN?.trim();
  if (!token) return true;
  return request.headers.get('authorization') === `Bearer ${token}`;
}

function scopedQuery(query: string, repos: string[]): string {
  const repoFilter = repos
    .map((repo) => `r:${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    .join(' or ');
  return `(${query}) (${repoFilter})`;
}

function isRepoName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}
