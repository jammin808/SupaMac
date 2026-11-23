import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

/** Origins of a developer's machine and the desktop app's webview, allowed
 * when `ALLOWED_ORIGINS` names none. A deployment names its own origins. */
const DEVELOPMENT_ORIGINS = new Set([
  'http://localhost:5173',
  'http://host.local:3000',
  'http://tauri.localhost',
  'tauri://localhost',
]);

function isDevelopmentOrigin(origin: string): boolean {
  if (DEVELOPMENT_ORIGINS.has(origin)) return true;

  const localhostPort = origin.match(/^http:\/\/localhost:(\d+)$/)?.[1];
  if (localhostPort) {
    const port = Number(localhostPort);
    return (port >= 3000 && port <= 3999) || (port >= 20000 && port <= 60000);
  }
  return false;
}

/**
 * Whether a browser at `origin`, the value of an `Origin` header, may read
 * this worker's responses. `configured` is the `ALLOWED_ORIGINS` worker
 * variable: comma-separated origins, each as a browser sends it
 * (`scheme://host[:port]`). When it names any, exactly those are allowed,
 * compared exactly; when it names none, only the development origins are.
 * The variable is read as `macro_cors::OriginAllowList` and sync-service's
 * allow-list read theirs.
 */
export function isOriginAllowed(
  origin: string,
  configured: string | undefined
): boolean {
  const origins = (configured ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (origins.length === 0) return isDevelopmentOrigin(origin);
  return origins.includes(origin);
}

/** How long a browser may reuse a preflight answer, in seconds; Chromium
 * caps it at two hours. Without it every edit waits for a fresh preflight. */
export const PREFLIGHT_MAX_AGE_SECONDS = 7200;

/** CORS for the browser's calls. They authenticate with the document
 * permission token in the body, not a cookie, so credentials stay off. */
export function originCors(): MiddlewareHandler<{
  Bindings: { ALLOWED_ORIGINS: string | undefined };
}> {
  return cors({
    origin: (origin, c) =>
      isOriginAllowed(origin, c.env.ALLOWED_ORIGINS) ? origin : null,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  });
}
