import { isTauri } from '@core/util/platform';

// The path the web bundle is served from. App builds set it from
// MACRO_APP_BASE_PATH (see vite.base.ts); everything else runs at `/app`.
const WEB_BASE_PATH = import.meta.env.__APP_BASE_PATH__ ?? '/app';

export const ROUTER_BASE = isTauri() ? '/' : WEB_BASE_PATH;

export const ROUTER_BASE_CONCAT = isTauri() ? '/' : `${WEB_BASE_PATH}/`;

/**
 * Strip the router base from a `location.pathname` (which includes it, e.g.
 * `/app/home`) so it can be compared to — and reused with — the
 * base-relative paths that `navigate()` and route definitions use.
 */
export const toBaseRelative = (pathname: string): string => {
  if (ROUTER_BASE === '/') return pathname;
  if (pathname === ROUTER_BASE) return '/';
  if (pathname.startsWith(`${ROUTER_BASE}/`)) {
    return pathname.slice(ROUTER_BASE.length);
  }
  return pathname;
};
