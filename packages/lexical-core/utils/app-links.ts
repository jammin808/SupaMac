/**
 * Where links into the web app and to its static files point. A host that
 * knows its own addresses (the web app: the origin and base path it is served
 * at, and its static-file service) sets them once at startup with
 * `configureAppLinks`. Without them, links follow the page: its origin under
 * `/app`. Outside a page and without a configured app URL there is no app to
 * link to, and without a configured static-file URL no link is a static file.
 */
export type AppLinkConfig = {
  /** The web app's origin and base path, such as `https://example.com/app`. */
  appUrl?: string;
  /**
   * The static-file service's public URL, such as
   * `https://api.example.com/static-file`; it serves files at `/file/<id>`.
   */
  staticFileUrl?: string;
};

type AppLinks = {
  appUrl: string | undefined;
  bookingUrlPattern: RegExp;
  /** Regex source matching the start of a static file's URL. */
  staticFileUrlSource: string;
  staticFileUrlPattern: RegExp;
};

/** A pattern source that matches nothing. */
const NO_MATCH_SOURCE = '(?!)';

/** `/book/:profile/:slug?` after the app URL, with an optional query or hash. */
const BOOKING_PATH_SOURCE = String.raw`\/book\/([^/?#]+)(?:\/([^/?#]+))?(?:[?#].*)?$`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The URL's origin and path without a trailing slash; throws on a non-URL. */
function normalizeBaseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function resolve(config: AppLinkConfig): AppLinks {
  const appUrl = config.appUrl ? normalizeBaseUrl(config.appUrl) : undefined;
  const staticFileUrl = config.staticFileUrl
    ? normalizeBaseUrl(config.staticFileUrl)
    : undefined;
  const staticFileUrlSource = staticFileUrl
    ? `${escapeRegExp(staticFileUrl)}\\/file\\/`
    : NO_MATCH_SOURCE;
  const bookingAppUrl = appUrl ?? pageAppUrl();
  return {
    appUrl,
    bookingUrlPattern: new RegExp(
      bookingAppUrl
        ? `^${escapeRegExp(bookingAppUrl)}${BOOKING_PATH_SOURCE}`
        : NO_MATCH_SOURCE
    ),
    staticFileUrlSource,
    staticFileUrlPattern: new RegExp(`^${staticFileUrlSource}`, 'i'),
  };
}

let links: AppLinks = resolve({});

/**
 * Replaces the link configuration; `{}` restores the page-relative defaults.
 * Throws on a value that is not an absolute URL.
 */
export function configureAppLinks(config: AppLinkConfig): void {
  links = resolve(config);
}

/** The page's own app URL: its origin under `/app`, or none outside a page. */
function pageAppUrl(): string | undefined {
  const origin =
    typeof window === 'undefined' ? undefined : window.location?.origin;
  return origin && origin !== 'null' ? `${origin}/app` : undefined;
}

/**
 * An absolute link to a path of the web app relative to its base path (such
 * as `/md/<id>`), or undefined where there is no app to link to.
 */
export function appLinkUrl(path: string): string | undefined {
  const base = links.appUrl ?? pageAppUrl();
  return base === undefined ? undefined : `${base}${path}`;
}

/** Matches a link to this app's booking page, capturing profile and slug. */
export function bookingUrlPattern(): RegExp {
  return links.bookingUrlPattern;
}

/** Regex source matching the start of a static file's URL (`<service>/file/`). */
export function staticFileUrlSource(): string {
  return links.staticFileUrlSource;
}

/** True when `url` names a file the static-file service serves. */
export function isStaticFileUrl(url: string): boolean {
  return links.staticFileUrlPattern.test(url);
}
