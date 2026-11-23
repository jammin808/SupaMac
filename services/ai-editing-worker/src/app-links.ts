import { configureAppLinks } from '@macro-inc/lexical-core';
import type { MiddlewareHandler } from 'hono';

/** The worker variables that say where the instance's web app and files are. */
export type AppLinkBindings = {
  /** The web app's origin and the folder it is served from. */
  APP_URL: string | undefined;
  /** The static-file service's public URL (it serves `/file/<id>`). */
  STATIC_FILE_URL: string | undefined;
};

let configured: string | undefined;

/**
 * Points lexical-core's app and static-file links at the deployment named by
 * `APP_URL` and `STATIC_FILE_URL`, so documents the worker converts keep their
 * video embeds and booking links. Unset values leave lexical-core's
 * page-relative defaults, which trust no other host. A value that is not an
 * absolute URL fails the request.
 */
export function appLinks(): MiddlewareHandler<{ Bindings: AppLinkBindings }> {
  return async (c, next) => {
    const appUrl = c.env.APP_URL || undefined;
    const staticFileUrl = c.env.STATIC_FILE_URL || undefined;
    const key = JSON.stringify([appUrl, staticFileUrl]);
    if (key !== configured) {
      configureAppLinks({ appUrl, staticFileUrl });
      configured = key;
    }
    await next();
  };
}
