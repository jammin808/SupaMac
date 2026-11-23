import { isTauri } from '@core/util/platform';

/**
 * The path the web bundle is served from. App builds set it from
 * MACRO_APP_BASE_PATH (see vite.base.ts); everything else runs at `/app`.
 * Every URL into the web app is built on it and parsed against it, in the
 * native shells too: they route at `/` but share and open web links.
 */
export const WEB_BASE_PATH = import.meta.env.__APP_BASE_PATH__ ?? '/app';

export const ROUTER_BASE = isTauri() ? '/' : WEB_BASE_PATH;

export const ROUTER_BASE_CONCAT = isTauri() ? '/' : `${WEB_BASE_PATH}/`;

/**
 * The base-relative path of a web app URL's path (`/app/md/1` gives `/md/1`),
 * or undefined for a path outside the web app.
 */
export const fromWebBasePath = (pathname: string): string | undefined => {
  if (pathname === WEB_BASE_PATH) return '/';
  if (pathname.startsWith(`${WEB_BASE_PATH}/`)) {
    return pathname.slice(WEB_BASE_PATH.length);
  }
  return undefined;
};

/**
 * Strip the router base from a `location.pathname` (which includes it, e.g.
 * `/app/home`) so it can be compared to — and reused with — the
 * base-relative paths that `navigate()` and route definitions use.
 */
export const toBaseRelative = (pathname: string): string => {
  if (ROUTER_BASE === '/') return pathname;
  return fromWebBasePath(pathname) ?? pathname;
};
