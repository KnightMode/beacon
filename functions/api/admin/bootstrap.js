// Establishes Cloudflare Access authorization for the /api/admin* Access app
// via a top-level navigation, then returns to the portal. The admin paths are
// separate Access applications, and after a fresh Access sign-in the browser
// is only authorized for the app it navigated through (/admin*). fetch() to
// /api/admin/* cannot follow Access's cross-origin login redirect, so the
// portal's first XHR would fail until some top-level navigation hits this app.
export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get('return') || '/admin/';
  const safe = target.startsWith('/') && !target.startsWith('//') ? target : '/admin/';
  return new Response(null, {
    status: 302,
    headers: { location: safe, 'cache-control': 'no-store' },
  });
}
