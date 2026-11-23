import { MacroError } from '../../utils';
import type { MacroClient } from '../../utils/client';
import { webAppBase, webAppLink } from '../../utils/web-app';

/** The path after `basePath`, or undefined for a path outside it. */
function pathUnder(pathname: string, basePath: string): string | undefined {
  if (pathname === basePath) return '/';
  if (!pathname.startsWith(`${basePath}/`)) return undefined;
  return pathname.slice(basePath.length);
}

/**
 * A link into this client's web app, reduced to the app path it opens: a list
 * view such as Tasks or Mail, or an item. Made by `macro.ui.link(url)`; it
 * keeps no origin.
 *
 * @mcp-exclude Only `macro.ui.open` takes it, which MCP leaves out.
 */
export class AppLink {
  private constructor(
    private readonly client: MacroClient,
    /** The path after the app's base path, with its query, such as `/tasks?s0.tasks.tab=mine`. */
    readonly path: string,
  ) {}

  /**
   * Parse a link into this client's web app (`<webAppUrl>/app/...`, or under
   * the base path `webAppUrl` names). Throws on anything else: another site,
   * a path outside the app, or a link with a fragment.
   */
  static parse(client: MacroClient, url: string): AppLink {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MacroError(`Not a Macro app link: ${url}`);
    }

    const { origin, basePath } = webAppBase(client.webAppUrl);
    const own = new URL(origin);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = pathUnder(parsed.pathname, basePath);
    const secure =
      parsed.protocol === 'https:' ||
      // A local web app is served over http.
      (parsed.protocol === 'http:' && own.protocol === 'http:');
    if (
      host !== own.hostname ||
      path === undefined ||
      !secure ||
      parsed.hash !== ''
    ) {
      throw new MacroError(`Not a Macro app link: ${url}`);
    }

    return new AppLink(client, `${path}${parsed.search}`);
  }

  /** The link on this client's web app, for a reply. */
  webUrl(): string {
    return webAppLink(this.client.webAppUrl, this.path);
  }

  toJSON() {
    return { path: this.path, url: this.webUrl() };
  }
}
