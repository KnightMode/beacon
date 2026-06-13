import { requireAdminAccess, shouldProtectAdminPath } from './_lib/access.js';
import { handleError } from './_lib/admin.js';

export async function onRequest(context) {
  const pathname = new URL(context.request.url).pathname;
  if (!shouldProtectAdminPath(pathname)) return context.next();

  try {
    await requireAdminAccess(context);
    return context.next();
  } catch (err) {
    return handleError(err);
  }
}
