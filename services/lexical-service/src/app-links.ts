import { configureAppLinks } from "@macro-inc/lexical-core";

/** The settings that say where the instance's web app and files are. */
export type AppLinkEnv = {
	/** The web app's origin and the folder it is served from. */
	APP_URL?: string;
	/** The static-file service's public URL (it serves `/file/<id>`). */
	STATIC_FILE_URL?: string;
};

/**
 * Points lexical-core's app and static-file links at the deployment, so the
 * documents this service converts keep their video embeds and booking links.
 * Unset values leave lexical-core's defaults, which trust no other host.
 * Throws on a value that is not an absolute URL, so startup fails on it.
 */
export function configureAppLinksFromEnv(env: AppLinkEnv): void {
	configureAppLinks({
		appUrl: env.APP_URL || undefined,
		staticFileUrl: env.STATIC_FILE_URL || undefined,
	});
}
