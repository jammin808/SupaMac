import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

type Scripts = { inline: string[]; sources: string[] };

type PackageOptions = {
	dist: string;
	basePath: string;
	backendOrigin: string;
	out: string;
	enforceCsp: boolean;
	omitVideos: boolean;
	keepSourceMaps: boolean;
};

type FolderSize = { files: number; bytes: number };

/** The rule the web build applies to MACRO_APP_BASE_PATH (apps/web/vite.base.ts). */
export function parseBasePath(value: string): string {
	if (!/^(\/[A-Za-z0-9_-]+)+$/.test(value)) {
		throw new Error(
			`The base path must look like /workspace or /team/app, got "${value}"`,
		);
	}
	return value;
}

/** The rule the web build applies to VITE_BACKEND_ORIGIN. */
export function parseBackendOrigin(value: string): string {
	const url = URL.canParse(value) ? new URL(value) : undefined;
	if (url?.protocol !== "https:" || url.origin !== value) {
		throw new Error(
			`The backend origin must be an https origin with no path, got "${value}"`,
		);
	}
	return value;
}

/** Every file under a directory, as sorted paths relative to it with `/` separators. */
export function listFiles(directory: string): string[] {
	const files: string[] = [];
	const visit = (relative: string) => {
		for (const entry of readdirSync(join(directory, relative), {
			withFileTypes: true,
		})) {
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) visit(path);
			else files.push(path);
		}
	};
	visit("");
	return files.sort();
}

/** The inline scripts of an HTML document and the URLs of its external ones. */
export function readScripts(html: string): Scripts {
	const scripts: Scripts = { inline: [], sources: [] };
	let external = false;
	new HTMLRewriter()
		.on("script", {
			element(element) {
				const source = element.getAttribute("src");
				external = source !== null;
				if (source === null) scripts.inline.push("");
				else scripts.sources.push(source);
			},
			text(chunk) {
				if (!external) scripts.inline[scripts.inline.length - 1] += chunk.text;
			},
		})
		.transform(html);
	return scripts;
}

/**
 * The CSP source that allows one inline script. A browser hashes the script as
 * parsed, and its parser turns every line break into a line feed first.
 */
export function inlineScriptSource(script: string): string {
	const parsed = script.replace(/\r\n?/g, "\n");
	const hash = createHash("sha256").update(parsed).digest("base64");
	return `'sha256-${hash}'`;
}

/**
 * The policy for the app's pages. A source is listed only where the app loads
 * from it; the comment on each directive says what does.
 */
export function contentSecurityPolicy(
	backendOrigin: string,
	inlineScripts: string[],
): string {
	const backendSocket = backendOrigin.replace(/^https/, "wss");
	const scriptHashes = [...new Set(inlineScripts.map(inlineScriptSource))];

	const directives = [
		// What has no directive of its own, such as the web app manifest.
		["default-src", "'self'"],

		// The bundle's files and the inline scripts of its HTML entries, by hash.
		// 'wasm-unsafe-eval' compiles the app's WebAssembly (document sync, the
		// local cache, the file engines); it does not allow eval of script text.
		["script-src", "'self'", ...scriptHashes, "'wasm-unsafe-eval'"],

		// The UI framework, the editors and rendered mail set style attributes
		// and add <style> elements at run time, which no hash can list.
		["style-src", "'self'", "'unsafe-inline'"],

		// data: and blob: are images the app makes itself: previews, pasted and
		// decoded files, mail attachments. Remote images in mail, markdown and
		// link previews come through the backend's image and unfurl proxies.
		// Loaded directly: GitHub avatars on pull requests (github.com redirects
		// to its avatar host) and GIFs from the picker's provider. A remote
		// background image in a mail's own CSS is not proxied and stays blocked.
		[
			"img-src",
			"'self'",
			"data:",
			"blob:",
			backendOrigin,
			"https://github.com",
			"https://avatars.githubusercontent.com",
			"https://static.klipy.com",
		],

		// Bundled sounds and videos, stored files from the backend, and blob:
		// for recordings, voice samples and media inside opened files.
		["media-src", "'self'", "blob:", backendOrigin],

		// Bundled fonts; data: for fonts embedded in styles (KaTeX, the PDF
		// viewer); Google's font files for text in opened design files.
		["font-src", "'self'", "data:", "https://fonts.gstatic.com"],

		// The backend over https and its websockets. data: and blob: because an
		// image dropped in as HTML is read back from its own source with fetch.
		// The GIF search and the design viewer's Google Fonts requests are the
		// app's only calls to other hosts.
		[
			"connect-src",
			"'self'",
			backendOrigin,
			backendSocket,
			"data:",
			"blob:",
			"https://api.klipy.com",
			"https://fonts.googleapis.com",
			"https://fonts.gstatic.com",
		],

		// blob: prints a PDF from a hidden frame. The rest are players and the
		// connector sign-in the app embeds: tour videos, Loom and Supercut link
		// previews, Pipedream Connect. Artifact and HTML previews are srcdoc
		// frames, which this directive does not govern; they inherit this whole
		// policy instead, so an enforced policy stops their inline scripts.
		[
			"frame-src",
			"blob:",
			"https://www.youtube-nocookie.com",
			"https://www.loom.com",
			"https://supercut.ai",
			"https://pipedream.com",
		],

		// The bundle's workers; blob: for the ones libraries build from text
		// (CSV parsing, call media processing, audio recording).
		["worker-src", "'self'", "blob:"],

		["object-src", "'none'"],
		["base-uri", "'self'"],

		// Forms post to the app or to the backend, nowhere else.
		["form-action", "'self'", backendOrigin],

		// Only this site may frame the app.
		["frame-ancestors", "'self'"],
	];
	return directives.map((directive) => directive.join(" ")).join("; ");
}

/**
 * Calls and screen sharing keep the camera, the microphone and screen capture.
 * The sensors and device ports listed empty are ones the app never asks for.
 * Features it uses or hands to an embedded player (clipboard, fullscreen,
 * picture-in-picture, local fonts, audio output) keep the browser's default.
 */
const PERMISSIONS_POLICY = [
	"camera=(self)",
	"microphone=(self)",
	"display-capture=(self)",
	"geolocation=()",
	"accelerometer=()",
	"gyroscope=()",
	"magnetometer=()",
	"usb=()",
	"serial=()",
	"hid=()",
	"midi=()",
	"payment=()",
].join(", ");

/** Names the current build instead of a content hash: never cached. */
const ENTRY_POINT = /(\.(html|json|txt)|^sw\.js)$/;

/**
 * The build names a content-hashed file
 * `<name>-<8 URL-safe base64 characters>.<extension>`. The name is all there
 * is to go on: a file from `apps/web/public` named the same way, such as
 * `icon-maskable.png`, would be taken for one and cached for a year.
 */
const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.([A-Za-z0-9.]+)$/;

/**
 * The file-name pattern of the bundle's content-hashed files, or undefined
 * when it has none. The extensions are listed from the bundle because a
 * pattern open to any extension would also match an entry point shaped like a
 * hashed name (`bundle-manifest.json`), and one file must never match both
 * cache rules.
 */
export function immutableFilePattern(files: string[]): string | undefined {
	const extensions = new Set<string>();
	for (const file of files) {
		const name = basename(file);
		const extension = HASHED_NAME.exec(name)?.[1];
		if (extension && !ENTRY_POINT.test(name)) extensions.add(extension);
	}
	if (extensions.size === 0) return undefined;
	const alternatives = [...extensions].sort().join("|").replaceAll(".", "\\.");
	return `-[A-Za-z0-9_-]{8}\\.(${alternatives})$`;
}

/** The rules the app needs in its folder on hosting that reads `.htaccess`. */
export function htaccess(
	basePath: string,
	backendOrigin: string,
	files: string[],
	policy: { contentSecurityPolicy: string; enforce: boolean },
): string {
	const immutable = immutableFilePattern(files);
	const immutableRule = immutable
		? `<FilesMatch "${immutable}">
	Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>
`
		: "";
	const policyHeader = policy.enforce
		? "Content-Security-Policy"
		: "Content-Security-Policy-Report-Only";

	return `# Written by tooling/supamac/package-web.ts for the folder ${basePath} and the
# backend ${backendOrigin}. Run the tool again instead of editing this file.

AddType application/wasm .wasm

RewriteEngine On
RewriteBase ${basePath}/

# The folder without its trailing slash. Apache answers that address with its
# own redirect and skips these rules; this rule is for a server that reads them.
RewriteCond %{REQUEST_URI} ^${basePath}$
RewriteRule ^ ${basePath}/ [R=301,L]

# A file that exists is served as it is.
RewriteCond %{REQUEST_FILENAME} -f
RewriteRule ^ - [L]

# A missing path that ends in a file extension is left alone, so the server
# answers with its own 404 and never the app's page: a script or style that
# is gone must fail to load. A path with @ is an app route that names an
# address.
RewriteCond %{REQUEST_URI} !@
RewriteRule \\.[^/]+$ - [L]

# Every other path is a route inside the app.
RewriteRule ^ index.html [L]

# A file is revalidated on every use unless a rule below says otherwise.
Header set Cache-Control "no-cache"
${immutableRule}<FilesMatch "${ENTRY_POINT.source}">
	Header set Cache-Control "no-store"
</FilesMatch>

Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "strict-origin-when-cross-origin"
Header always set Cross-Origin-Opener-Policy "same-origin-allow-popups"
# A report-only policy does not stop framing, so this header does in both modes.
Header always set X-Frame-Options "SAMEORIGIN"
Header always set Permissions-Policy "${PERMISSIONS_POLICY}"
Header always set ${policyHeader} "${policy.contentSecurityPolicy}"
`;
}

/**
 * The order to upload a packaged folder in. A page must never be served
 * before the files it loads or under the previous build's rules, so hashed
 * and other files go first, then the rules, then the HTML entry points.
 */
export function uploadOrder(files: string[]): string[] {
	const pages = files.filter((file) => file.endsWith(".html"));
	const others = files.filter(
		(file) => !file.endsWith(".html") && file !== ".htaccess",
	);
	return [...others, ".htaccess", ...pages];
}

/** Refuse a bundle that was built for another folder or another backend. */
export function assertBuiltFor(
	dist: string,
	basePath: string,
	backendOrigin: string,
): void {
	const indexPath = join(dist, "index.html");
	if (!existsSync(indexPath)) {
		throw new Error(`${indexPath} does not exist: build the web app first`);
	}

	// A script the page loads from the folder is a file of the bundle at the
	// same path below it. A bundle built for a deeper folder (/team/app, asked
	// for /team) loads from the folder too, but from a path the bundle lacks.
	const { sources } = readScripts(readFileSync(indexPath, "utf8"));
	const loadsFromFolder = sources.some(
		(source) =>
			source.startsWith(`${basePath}/`) &&
			existsSync(join(dist, source.slice(basePath.length + 1))),
	);
	if (!loadsFromFolder) {
		throw new Error(
			`index.html loads no script of the bundle from ${basePath}/: build the web app with MACRO_APP_BASE_PATH=${basePath}`,
		);
	}

	// The build writes the origin into the scripts as one string literal. The
	// closing quote keeps a longer host that starts the same from matching.
	const literals = ['"', "'", "`"].map((quote) => `${backendOrigin}${quote}`);
	const addressesBackend = listFiles(dist)
		.filter((file) => file.endsWith(".js"))
		.some((file) => {
			const script = readFileSync(join(dist, file), "utf8");
			return literals.some((literal) => script.includes(literal));
		});
	if (!addressesBackend) {
		throw new Error(
			`No script in the bundle addresses ${backendOrigin}: build the web app with VITE_BACKEND_ORIGIN=${backendOrigin}. A bundle built without it calls the upstream hosts and loads their analytics.`,
		);
	}
}

function folderSize(directory: string, files: string[]): FolderSize {
	let bytes = 0;
	for (const file of files) bytes += statSync(join(directory, file)).size;
	return { files: files.length, bytes };
}

/** Write the folder to publish and, beside it, the order to upload it in. */
export function packageWeb(options: PackageOptions): {
	bundle: FolderSize;
	published: FolderSize;
	manifest: string;
} {
	const basePath = parseBasePath(options.basePath);
	const backendOrigin = parseBackendOrigin(options.backendOrigin);
	assertBuiltFor(options.dist, basePath, backendOrigin);
	if (existsSync(options.out) && readdirSync(options.out).length > 0) {
		throw new Error(`${options.out} is not empty: choose a new output folder`);
	}

	const bundle = listFiles(options.dist);
	const kept = bundle.filter((file) => {
		if (!options.keepSourceMaps && file.endsWith(".map")) return false;
		if (options.omitVideos && file.startsWith("web-hosted/")) return false;
		return true;
	});
	for (const file of kept) {
		mkdirSync(dirname(join(options.out, file)), { recursive: true });
		copyFileSync(join(options.dist, file), join(options.out, file));
	}

	const inlineScripts = kept
		.filter((file) => file.endsWith(".html"))
		.flatMap(
			(file) =>
				readScripts(readFileSync(join(options.out, file), "utf8")).inline,
		);
	writeFileSync(
		join(options.out, ".htaccess"),
		htaccess(basePath, backendOrigin, kept, {
			contentSecurityPolicy: contentSecurityPolicy(
				backendOrigin,
				inlineScripts,
			),
			enforce: options.enforceCsp,
		}),
	);

	const manifest = `${options.out.replace(/\/+$/, "")}.publish.json`;
	const publish = {
		basePath,
		backendOrigin,
		contentSecurityPolicy: options.enforceCsp ? "enforced" : "report-only",
		upload: uploadOrder(kept),
	};
	writeFileSync(manifest, `${JSON.stringify(publish, null, "\t")}\n`);

	const published = listFiles(options.out);
	return {
		bundle: folderSize(options.dist, bundle),
		published: folderSize(options.out, published),
		manifest,
	};
}

const USAGE = `Usage: bun run supamac:package-web --dist <dir> --base-path </folder> --backend-origin <https origin> --out <dir>
  --enforce-csp       send Content-Security-Policy instead of the report-only header
  --omit-videos       leave out web-hosted/, the tutorial videos
  --keep-source-maps  publish the *.map files`;

function main(): void {
	const megabytes = (size: FolderSize) => (size.bytes / 1024 ** 2).toFixed(1);
	try {
		const { values } = parseArgs({
			options: {
				dist: { type: "string" },
				"base-path": { type: "string" },
				"backend-origin": { type: "string" },
				out: { type: "string" },
				"enforce-csp": { type: "boolean", default: false },
				"omit-videos": { type: "boolean", default: false },
				"keep-source-maps": { type: "boolean", default: false },
			},
		});
		const basePath = values["base-path"];
		const backendOrigin = values["backend-origin"];
		if (!values.dist || !basePath || !backendOrigin || !values.out) {
			throw new Error(USAGE);
		}

		const result = packageWeb({
			dist: values.dist,
			basePath,
			backendOrigin,
			out: values.out,
			enforceCsp: values["enforce-csp"],
			omitVideos: values["omit-videos"],
			keepSourceMaps: values["keep-source-maps"],
		});
		console.log(
			`Bundle: ${result.bundle.files} files, ${megabytes(result.bundle)} MB`,
		);
		console.log(
			`Folder to publish: ${result.published.files} files, ${megabytes(result.published)} MB in ${values.out}`,
		);
		console.log(`Upload order: ${result.manifest}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}

if (import.meta.main) main();
