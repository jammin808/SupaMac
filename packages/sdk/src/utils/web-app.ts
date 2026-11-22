/** Where the web app is served when `webAppUrl` names only its origin. */
const DEFAULT_BASE_PATH = '/app';

/** The web app's origin and the path it is served from. */
export type WebAppBase = { origin: string; basePath: string };

/**
 * Splits a client's `webAppUrl` into the app's origin and base path. The URL
 * is the origin, optionally followed by the path the app is served from (such
 * as `https://example.com/workspace`); an origin alone serves it at `/app`.
 * A value that is not a URL is taken whole as the origin.
 */
export function webAppBase(webAppUrl: string): WebAppBase {
  let url: URL;
  try {
    url = new URL(webAppUrl);
  } catch {
    return { origin: String(webAppUrl), basePath: DEFAULT_BASE_PATH };
  }
  const path = url.pathname.replace(/\/+$/, '');
  return { origin: url.origin, basePath: path || DEFAULT_BASE_PATH };
}

/** The web app link of a path relative to its base path, such as `/md/<id>`. */
export function webAppLink(webAppUrl: string, path: string): string {
  const { origin, basePath } = webAppBase(webAppUrl);
  return `${origin}${basePath}${path}`;
}
