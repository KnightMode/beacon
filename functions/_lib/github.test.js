import { beforeEach, describe, expect, it, vi } from 'vitest';

const octokit = vi.hoisted(() => {
  const githubRequest = vi.fn();
  const authHook = vi.fn();

  const defaults = vi.fn((defaultsOptions = {}) => {
    const request = vi.fn((route, parameters) =>
      githubRequest(route, parameters, defaultsOptions),
    );
    request.defaults = defaults;
    return request;
  });

  return { authHook, defaults, githubRequest };
});

const createAppAuth = vi.hoisted(() => vi.fn(() => ({ hook: octokit.authHook })));

vi.mock('@octokit/auth-app', () => ({ createAppAuth }));
vi.mock('@octokit/request', () => ({ request: { defaults: octokit.defaults } }));

const {
  queryInstallationRepositories,
} = await import('./github.js');

describe('GitHub App installation repository client', () => {
  beforeEach(() => {
    createAppAuth.mockClear();
    octokit.authHook.mockClear();
    octokit.defaults.mockClear();
    octokit.githubRequest.mockReset();
  });

  it('returns null when GitHub App credentials are not configured', async () => {
    await expect(queryInstallationRepositories({}, 12345)).resolves.toBeNull();

    expect(createAppAuth).not.toHaveBeenCalled();
    expect(octokit.githubRequest).not.toHaveBeenCalled();
  });

  it('uses Octokit GitHub App auth and filters installation repositories', async () => {
    octokit.githubRequest.mockResolvedValueOnce({
      data: {
        repositories: [
          {
            full_name: 'KnightMode/beacon',
            id: 42,
            default_branch: 'main',
            private: true,
          },
          {
            full_name: 'OtherOrg/api',
            id: 84,
            default_branch: '',
            private: false,
          },
        ],
      },
    });

    const result = await queryInstallationRepositories(
      githubEnv(),
      12345,
      { q: 'beacon', limit: 5 },
    );

    expect(createAppAuth).toHaveBeenCalledWith(expect.objectContaining({
      appId: '99',
      installationId: 12345,
      privateKey: expect.stringContaining('-----BEGIN PRIVATE KEY-----'),
      request: expect.any(Function),
    }));
    expect(octokit.defaults).toHaveBeenCalledWith({
      request: { hook: octokit.authHook },
    });
    expect(octokit.githubRequest).toHaveBeenCalledWith(
      'GET /installation/repositories',
      { per_page: 100, page: 1 },
      { request: { hook: octokit.authHook } },
    );
    expect(result).toEqual({
      repos: [
        {
          fullName: 'KnightMode/beacon',
          githubId: 42,
          defaultBranch: 'main',
          private: true,
        },
      ],
      page: 1,
      hasMore: false,
      totalScanned: 2,
    });
  });

  it('keeps Octokit errors actionable without leaking response objects', async () => {
    const err = new Error('Request failed');
    err.status = 401;
    err.response = { data: { message: 'Bad credentials' } };
    octokit.githubRequest.mockRejectedValueOnce(err);

    await expect(
      queryInstallationRepositories(githubEnv(), 12345),
    ).rejects.toThrow('GitHub repo list failed (401): Bad credentials');
  });
});

function githubEnv() {
  return {
    GITHUB_APP_ID: '99',
    GITHUB_APP_PRIVATE_KEY:
      '"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"',
  };
}
