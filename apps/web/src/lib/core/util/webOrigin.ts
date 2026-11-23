import { SELF_HOSTED } from '@core/constant/selfHosted';
import { isTauri } from './platform';

/**
 * The origin of the web app. The native apps of the hosted service name its
 * web deployment; every other page, and every self-hosted bundle, is served
 * from the app's own origin.
 */
export function getWebOrigin(): string {
  if (!SELF_HOSTED && isTauri()) {
    return import.meta.env.MODE === 'development'
      ? 'https://dev.macro.com'
      : 'https://macro.com';
  }
  return window.location.origin;
}

/**
 * The origin of a link people copy out of an editor. A self-hosted instance
 * links the origin serving it; a hosted page links its own host over https,
 * and a local one the hosted development deployment.
 */
export function getCopiedLinkOrigin(): string {
  if (SELF_HOSTED) return getWebOrigin();
  const hostname = window.location.hostname.replace('www.', '').toLowerCase();
  return `https://${hostname === 'localhost' ? 'dev.macro.com' : hostname}`;
}
