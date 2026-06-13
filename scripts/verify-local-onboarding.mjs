#!/usr/bin/env node
/**
 * Smoke-test the admin onboarding flow against a local Pages dev server.
 *
 * Prereqs:
 *   npm run db:local:init
 *   cp site/.dev.vars.example site/.dev.vars
 *   npm run dev:portal   (in another terminal)
 *
 * Usage:
 *   npm run verify:local
 *   BASE_URL=http://127.0.0.1:8788 npm run verify:local
 */

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');

/** @type {Map<string, string>} */
const cookies = new Map();

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`✓ ${message}`);
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

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const cookie = cookieHeader();
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    redirect: 'manual',
  });
  storeCookies(res);
  return res;
}

async function followRedirects(startPath, maxHops = 8) {
  let path = startPath;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await request(path);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) fail(`Redirect without location from ${path}`);
      path = location.startsWith('http') ? new URL(location).pathname + new URL(location).search : location;
      continue;
    }
    return res;
  }
  fail(`Too many redirects starting at ${startPath}`);
}

async function main() {
  console.log(`Verifying local onboarding at ${BASE_URL}\n`);

  try {
    await fetch(`${BASE_URL}/api/admin/session`);
  } catch {
    fail(
      'Cannot reach the portal. Start it with: npm run dev:portal\n' +
      '  (and run npm run db:local:init first if this is a fresh machine)',
    );
  }

  const sessionBefore = await request('/api/admin/session');
  const beforeJson = await sessionBefore.json();
  if (beforeJson.authenticated) {
    console.log('Note: existing admin session detected; continuing with current cookies.');
  } else {
    pass('session endpoint reachable (unauthenticated)');
  }

  await followRedirects('/api/admin/slack/start?mock=1');
  if (!cookies.has('beacon_admin_session')) {
    fail('Slack mock OAuth did not set beacon_admin_session cookie');
  }
  pass('Slack mock OAuth completed');

  const onboarding = await request('/api/admin/onboarding');
  if (!onboarding.ok) {
    fail(`onboarding API failed (${onboarding.status}): ${await onboarding.text()}`);
  }
  const state = await onboarding.json();
  if (state.steps?.slack !== 'COMPLETE') {
    fail(`expected slack step COMPLETE, got ${state.steps?.slack}`);
  }
  pass(`tenant created (${state.tenant?.slackTeamId})`);

  await followRedirects('/api/admin/github/start?mock=1');
  const afterGithub = await request('/api/admin/onboarding');
  const githubState = await afterGithub.json();
  if (githubState.steps?.github !== 'COMPLETE') {
    fail(`expected github step COMPLETE, got ${githubState.steps?.github}`);
  }
  pass('GitHub mock install linked');

  const repoRes = await request('/api/admin/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repos: ['KnightMode/beacon'] }),
  });
  const repoJson = await repoRes.json();
  if (!repoRes.ok) {
    fail(`repo selection failed (${repoRes.status}): ${repoJson.error || JSON.stringify(repoJson)}`);
  }
  if (!repoJson.repos?.some((r) => r.fullName === 'KnightMode/beacon')) {
    fail('repo POST succeeded but KnightMode/beacon not in tenant repo list');
  }
  pass('repo selection persisted');
  if (repoJson.dispatchErrors?.length) {
    console.log(
      '  (index dispatch skipped or failed — set PIPELINE_DISPATCH_* in .dev.vars to test dispatch)',
    );
  }

  const final = await request('/api/admin/onboarding');
  const finalState = await final.json();
  if (finalState.steps?.repos !== 'COMPLETE') {
    fail(`expected repos step COMPLETE, got ${finalState.steps?.repos}`);
  }
  pass('onboarding repos step marked COMPLETE');

  console.log('\nAll local onboarding checks passed.');
  console.log('\nNext manual checks (optional):');
  console.log(`  • Admin UI:  ${BASE_URL}/admin/onboarding/`);
  console.log('  • Slack bot: npm run dev:bot  (shares .wrangler/state local D1)');
  console.log('  • Query local D1: npm run db:local:query -- "SELECT id, slack_team_id FROM tenants"');
}

main().catch((err) => fail(err.message));
