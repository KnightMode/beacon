#!/usr/bin/env node
/**
 * Local end-to-end onboarding check. Uses isolated Wrangler local D1 state,
 * mock Slack/GitHub OAuth, and local mock indexing. No real external
 * credentials are required.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.wrangler', 'e2e-state');

/** @type {Map<string, string>} */
const cookies = new Map();
/** @type {import('node:child_process').ChildProcess | null} */
let devServer = null;
const devLog = [];

function fail(message) {
  console.error(`\n✗ ${message}`);
  if (devLog.length) {
    console.error('\n--- wrangler pages dev output ---');
    console.error(devLog.slice(-80).join(''));
  }
  process.exitCode = 1;
}

function pass(message) {
  console.log(`✓ ${message}`);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function storeCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const part = line.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) cookies.set(part.slice(0, eq), part.slice(eq + 1));
  }
}

function cookieHeader() {
  if (cookies.size === 0) return undefined;
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function request(baseUrl, pathName, options = {}) {
  const headers = new Headers(options.headers || {});
  const cookie = cookieHeader();
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers,
    redirect: 'manual',
  });
  storeCookies(res);
  return res;
}

async function followRedirects(baseUrl, startPath, maxHops = 10) {
  let pathName = startPath;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await request(baseUrl, pathName);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`Redirect without location from ${pathName}`);
      const next = location.startsWith('http') ? new URL(location) : new URL(location, baseUrl);
      pathName = `${next.pathname}${next.search}`;
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects starting at ${startPath}`);
}

async function waitForPortal(baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const res = await fetch(`${baseUrl}/api/admin/session`);
      if (res.status < 500) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for local Pages dev server');
}

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

function startPagesDev(port) {
  const args = [
    'wrangler',
    'pages',
    'dev',
    'site',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--persist-to',
    STATE_DIR,
    '--binding',
    'BEACON_LOCAL_E2E=1',
    '--binding',
    'ADMIN_SESSION_SECRET=local-e2e-admin-secret',
    '--binding',
    'SLACK_TOKEN_ENCRYPTION_SECRET=local-e2e-slack-secret',
    '--binding',
    'SLACK_CLIENT_ID=local-e2e-client',
    '--binding',
    'SLACK_CLIENT_SECRET=local-e2e-client-secret',
    '--binding',
    'PIPELINE_DISPATCH_REPO=',
    '--binding',
    'PIPELINE_DISPATCH_TOKEN=',
    '--log-level',
    'error',
    '--show-interactive-dev-session',
    'false',
  ];
  devServer = spawn('npx', args, {
    cwd: ROOT,
    env: { ...process.env, BEACON_LOCAL_E2E: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [devServer.stdout, devServer.stderr]) {
    stream?.on('data', (chunk) => {
      devLog.push(chunk.toString());
      if (devLog.length > 200) devLog.shift();
    });
  }
  devServer.on('exit', (code) => {
    if (process.exitCode === undefined && code && code !== 0) {
      fail(`wrangler pages dev exited early with code ${code}`);
    }
  });
}

async function cleanup() {
  if (!devServer || devServer.killed) return;
  await new Promise((resolve) => {
    devServer.once('exit', resolve);
    devServer.kill('SIGTERM');
    setTimeout(() => {
      if (!devServer.killed) devServer.kill('SIGKILL');
      resolve();
    }, 2500).unref();
  });
}

async function main() {
  process.on('exit', () => {
    if (devServer && !devServer.killed) devServer.kill('SIGTERM');
  });
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });

  console.log('Preparing isolated local D1 state...');
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  run('npx', [
    'wrangler',
    'd1',
    'execute',
    'scintel',
    '--local',
    '--persist-to',
    STATE_DIR,
    '--file=packages/shared/schema.sql',
  ]);
  pass('local schema applied');

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  startPagesDev(port);
  await waitForPortal(baseUrl);
  pass(`portal started at ${baseUrl}`);

  await followRedirects(baseUrl, '/api/admin/slack/start?mock=1');
  if (!cookies.has('beacon_admin_session')) {
    throw new Error('Slack mock OAuth did not create an admin session');
  }
  pass('mock Slack OAuth completed');

  await followRedirects(baseUrl, '/api/admin/github/start?mock=1&installation_id=12345&account_login=KnightMode');
  await followRedirects(baseUrl, '/api/admin/github/start?mock=1&installation_id=67890&account_login=acme-corp');
  pass('two mock GitHub installations connected');

  const reposState = await json(await request(baseUrl, '/api/admin/github/repos?limit=100'));
  const installs = reposState.installations || [];
  if (installs.length !== 2) {
    throw new Error(`expected 2 installations, got ${installs.length}`);
  }
  const byName = new Map((reposState.repos || []).map((repo) => [repo.fullName, repo]));
  for (const fullName of ['KnightMode/beacon', 'acme-corp/api']) {
    if (!byName.has(fullName)) throw new Error(`repo picker missing ${fullName}`);
  }
  pass('repo picker lists repos from both installations');

  const selected = ['KnightMode/beacon', 'acme-corp/api'].map((fullName) => ({
    fullName,
    installationId: byName.get(fullName).installationId,
  }));
  const repoPost = await json(await request(baseUrl, '/api/admin/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repos: selected }),
  }));
  const statuses = new Map((repoPost.repos || []).map((repo) => [repo.fullName, repo.status]));
  for (const fullName of ['KnightMode/beacon', 'acme-corp/api']) {
    if (statuses.get(fullName) !== 'READY') {
      throw new Error(`${fullName} should be READY after local mock indexing`);
    }
  }
  pass('repos from both installations selected and locally indexed');

  const finalState = await json(await request(baseUrl, '/api/admin/onboarding'));
  if (finalState.steps?.channel !== undefined) {
    throw new Error('channel should not be a required onboarding step');
  }
  if (finalState.steps?.repos !== 'COMPLETE' || finalState.steps?.indexing !== 'COMPLETE') {
    throw new Error(`expected repos/indexing complete, got ${JSON.stringify(finalState.steps)}`);
  }
  if ((finalState.integrations?.githubInstallations || []).length !== 2) {
    throw new Error('onboarding summary did not include both GitHub installations');
  }
  pass('channel setup is optional and onboarding summary is multi-install aware');

  console.log('\nAll local E2E checks passed.');
  console.log(`Manual UI, while this run is active: ${baseUrl}/admin/onboarding/`);
}

main()
  .catch((err) => fail(err.message))
  .finally(cleanup);
