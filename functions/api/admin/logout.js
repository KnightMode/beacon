import { clearGithubLinkCookie, clearSessionCookie } from '../../_lib/admin.js';

// Logs the admin out: clears the Beacon session cookies and then hands off to
// Cloudflare Access's logout endpoint so the OTP session is dropped too. The
// browser ends up at the Access "logged out" screen and must re-authenticate
// before reaching the onboarding portal again.
export async function onRequestGet(context) {
  const headers = new Headers();
  headers.append('Set-Cookie', clearSessionCookie(context.request));
  headers.append('Set-Cookie', clearGithubLinkCookie(context.request));
  headers.set('Location', '/cdn-cgi/access/logout');
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}
