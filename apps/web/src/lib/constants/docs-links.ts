import type { ListView } from '@app/constants/list-views';
import { SELF_HOSTED } from '@core/constant/servers';

/** Base URL of the hosted service's public documentation site. */
const DOCS_BASE = 'https://docs.macro.com';

/**
 * The public documentation page at `path` (`/product/email`). The site is the
 * hosted service's own, so a self-hosted instance has no page to link:
 * callers render no link for `undefined`.
 */
export function docsUrl(path: string): string | undefined {
  return SELF_HOSTED ? undefined : `${DOCS_BASE}${path}`;
}

/** Task projects have their own collection rather than a legacy ListView. */
export const PROJECTS_DOCS_URL = docsUrl('/product/projects');

/** Public documentation page for each list view on the hosted service. */
function hostedListViewDocsUrls(): Partial<Record<ListView, string>> {
  return {
    home: `${DOCS_BASE}/product/home`,
    agents: `${DOCS_BASE}/product/agents`,
    mail: `${DOCS_BASE}/product/email`,
    documents: `${DOCS_BASE}/product/docs`,
    tasks: `${DOCS_BASE}/product/tasks`,
    channels: `${DOCS_BASE}/product/channels`,
    calls: `${DOCS_BASE}/product/calls`,
    companies: `${DOCS_BASE}/product/crm`,
    folders: `${DOCS_BASE}/product/drive`,
    search: `${DOCS_BASE}/product/search`,
  };
}

/**
 * Public documentation page for each list view. Views without an entry have no
 * docs page yet, and a self-hosted instance has none at all, so callers should
 * render no link for them. Only a hosted bundle builds the table, so a
 * self-hosted one carries none of its addresses.
 */
export const LIST_VIEW_DOCS_URL: Partial<Record<ListView, string>> = SELF_HOSTED
  ? {}
  : hostedListViewDocsUrls();
