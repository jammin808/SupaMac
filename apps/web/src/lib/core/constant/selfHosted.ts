// A self-hosted deployment puts every service behind one origin, on the same
// path prefixes as the local stack's proxy, and builds with VITE_BACKEND_ORIGIN
// set to it. That origin is used as given: the page and the backend can be on
// different hosts, so nothing follows the page's hostname.
export const SELF_HOSTED_BACKEND_ORIGIN: string | undefined = import.meta.env
  .VITE_BACKEND_ORIGIN;

/**
 * True in a bundle built for a self-hosted backend (VITE_BACKEND_ORIGIN). The
 * bundler folds `!!` of the inlined origin, unlike a `Boolean()` call, into a
 * constant in every module that reads it, so a self-hosted bundle leaves out
 * the hosted-only code this guards.
 */
export const SELF_HOSTED = !!SELF_HOSTED_BACKEND_ORIGIN;
