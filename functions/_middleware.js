import { requireAdminAccess, shouldProtectAdminPath } from './_lib/access.js';
import { handleError } from './_lib/admin.js';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname;

  // After logout, Cloudflare Access redirects back to the Access application
  // "domain", which is a path wildcard (e.g. askbeacon.dev/api/admin*). The
  // literal * path matches nothing and falls through to an unstyled static
  // fallback, so route those redirects to the homepage instead.
  if (pathname.includes('*')) {
    return Response.redirect(new URL('/', url), 302);
  }

  if (!shouldProtectAdminPath(pathname)) return context.next();

  try {
    await requireAdminAccess(context);
    return context.next();
  } catch (err) {
    return handleError(err);
  }
}
