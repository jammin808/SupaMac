import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertBuiltFor,
	contentSecurityPolicy,
	htaccess,
	immutableFilePattern,
	inlineScriptSource,
	listFiles,
	packageWeb,
	parseBackendOrigin,
	parseBasePath,
	readScripts,
	uploadOrder,
} from "./package-web";

// Names from a real production build of apps/web.
const BUNDLE = [
	"ActionDialogShell--bJP5yuP.js",
	"ActiveCallPopover-DtOoa_pv.js",
	"app-CZp2popx.js",
	"assets/KaTeX_AMS-Regular-DMm9YOAa.woff",
	"assets/KaTeX_AMS-Regular-DRggAlZN.ttf",
	"assets/calendar-poster-BSgJ19x8.jpg",
	"assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
	"assets/katex-B7QeSwCL.css",
	"assets/loro_wasm_bg-CGwE3r1S.wasm",
	"bundle-manifest.json",
	"cache.coordinator.shared-worker-cbCLfYra.js",
	"canvas-render.html",
	"dev/logo512.png",
	"favicon.ico",
	"index.html",
	"macro-favicon.svg",
	"macro-logo-orange.png",
	"manifest.json",
	"pipedream-connect.html",
	"semver.txt",
	"sounds/Kick - Struct - Tight Minimal 4.wav",
	"sw.js",
	"web-hosted/databases-C9a9ytc_.mp4",
];

describe("packaging the web bundle for static hosting", () => {
	test("the rules route the app inside its folder", () => {
		const rules = htaccess("/workspace", "https://api.example.com", BUNDLE, {
			contentSecurityPolicy: "default-src 'self'",
			enforce: false,
		});

		expect(rules).toContain(`RewriteEngine On
RewriteBase /workspace/
`);
		expect(rules).toContain(`RewriteCond %{REQUEST_URI} ^/workspace$
RewriteRule ^ /workspace/ [R=301,L]
`);
		expect(rules).toContain(`RewriteCond %{REQUEST_FILENAME} -f
RewriteRule ^ - [L]
`);
		expect(rules).toContain(`RewriteCond %{REQUEST_URI} !@
RewriteRule \\.[^/]+$ - [L]
`);
		expect(rules).toContain("RewriteRule ^ index.html [L]\n");
		expect(rules).toContain("AddType application/wasm .wasm\n");

		// An existing file is served before a missing one is left to the
		// server's 404, and the app's page is the last resort.
		const existing = rules.indexOf("RewriteCond %{REQUEST_FILENAME} -f");
		const missing = rules.indexOf("RewriteRule \\.[^/]+$ - [L]");
		const fallback = rules.indexOf("RewriteRule ^ index.html [L]");
		expect(existing).toBeLessThan(missing);
		expect(missing).toBeLessThan(fallback);

		// The missing-file rule sees the path below the folder: file-like
		// paths match, routes do not.
		const missingFile = /\.[^/]+$/;
		expect(missingFile.test("assets/gone-AbCd1234.js")).toBe(true);
		expect(missingFile.test("favicon.png")).toBe(true);
		expect(missingFile.test("channel/2f6c0c1e")).toBe(false);
		expect(missingFile.test("v1.2/settings")).toBe(false);
		expect(missingFile.test("")).toBe(false);
	});

	test("only content-hashed files are cached for good", () => {
		expect(immutableFilePattern(BUNDLE)).toBe(
			"-[A-Za-z0-9_-]{8}\\.(css|jpg|js|mp4|ttf|wasm|woff|woff2)$",
		);
		const rules = htaccess("/workspace", "https://api.example.com", BUNDLE, {
			contentSecurityPolicy: "default-src 'self'",
			enforce: false,
		});
		expect(rules).toContain(`Header set Cache-Control "no-cache"
<FilesMatch "-[A-Za-z0-9_-]{8}\\.(css|jpg|js|mp4|ttf|wasm|woff|woff2)$">
	Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>
<FilesMatch "(\\.(html|json|txt)|^sw\\.js)$">
	Header set Cache-Control "no-store"
</FilesMatch>
`);

		// The server matches these against the file's name without its folder.
		const immutable =
			/-[A-Za-z0-9_-]{8}\.(css|jpg|js|mp4|ttf|wasm|woff|woff2)$/;
		const noStore = /(\.(html|json|txt)|^sw\.js)$/;
		for (const hashed of [
			"ActionDialogShell--bJP5yuP.js",
			"ActiveCallPopover-DtOoa_pv.js",
			"app-CZp2popx.js",
			"KaTeX_AMS-Regular-DMm9YOAa.woff",
			"KaTeX_AMS-Regular-DRggAlZN.ttf",
			"calendar-poster-BSgJ19x8.jpg",
			"inter-latin-wght-normal-Dx4kXJAl.woff2",
			"katex-B7QeSwCL.css",
			"loro_wasm_bg-CGwE3r1S.wasm",
			"cache.coordinator.shared-worker-cbCLfYra.js",
			"databases-C9a9ytc_.mp4",
		]) {
			expect(immutable.test(hashed)).toBe(true);
			expect(noStore.test(hashed)).toBe(false);
		}
		for (const entryPoint of [
			"index.html",
			"canvas-render.html",
			"pipedream-connect.html",
			"manifest.json",
			"bundle-manifest.json",
			"semver.txt",
			"sw.js",
		]) {
			expect(noStore.test(entryPoint)).toBe(true);
			expect(immutable.test(entryPoint)).toBe(false);
		}
		for (const revalidated of [
			"favicon.ico",
			"macro-favicon.svg",
			"macro-logo-orange.png",
			"logo512.png",
			"Kick - Struct - Tight Minimal 4.wav",
		]) {
			expect(immutable.test(revalidated)).toBe(false);
			expect(noStore.test(revalidated)).toBe(false);
		}

		// Kept source maps are hashed files too; a bundle without hashed
		// names gets no immutable rule at all.
		expect(
			immutableFilePattern(["app-CZp2popx.js", "app-CZp2popx.js.map"]),
		).toBe("-[A-Za-z0-9_-]{8}\\.(js|js\\.map)$");
		expect(immutableFilePattern(["assets/app.js", "index.html"])).toBe(
			undefined,
		);
		expect(
			htaccess("/workspace", "https://api.example.com", ["index.html"], {
				contentSecurityPolicy: "default-src 'self'",
				enforce: false,
			}),
		).not.toContain("immutable");
	});

	test("the policy is report-only until it is asked to enforce", () => {
		const reportOnly = htaccess("/workspace", "https://api.example.com", [], {
			contentSecurityPolicy: "default-src 'self'",
			enforce: false,
		});
		expect(reportOnly).toContain(
			`Header always set Content-Security-Policy-Report-Only "default-src 'self'"\n`,
		);
		expect(reportOnly).not.toContain("Content-Security-Policy ");

		const enforced = htaccess("/workspace", "https://api.example.com", [], {
			contentSecurityPolicy: "default-src 'self'",
			enforce: true,
		});
		expect(enforced).toContain(
			`Header always set Content-Security-Policy "default-src 'self'"\n`,
		);
		expect(enforced).not.toContain("Report-Only");

		for (const rules of [reportOnly, enforced]) {
			expect(rules).toContain(
				'Header always set X-Content-Type-Options "nosniff"\n',
			);
			expect(rules).toContain(
				'Header always set Referrer-Policy "strict-origin-when-cross-origin"\n',
			);
			expect(rules).toContain(
				'Header always set Cross-Origin-Opener-Policy "same-origin-allow-popups"\n',
			);
			expect(rules).toContain(
				'Header always set X-Frame-Options "SAMEORIGIN"\n',
			);
			expect(rules).toContain(
				"camera=(self), microphone=(self), display-capture=(self), geolocation=()",
			);
		}
	});

	test("inline scripts are allowed by the hash of their text", () => {
		const html = [
			"<!doctype html>",
			"<html>",
			"  <head>",
			'    <script type="module" crossorigin src="/workspace/app-CZp2popx.js"></script>',
			"  </head>",
			"  <body>",
			"    <script>",
			"      window.__START_TIME__ = performance.now();",
			"    </script>",
			'    <script>document.title = "a < b && c > d";</script>',
			"  </body>",
			"</html>",
		].join("\n");

		const scripts = readScripts(html);
		expect(scripts.sources).toEqual(["/workspace/app-CZp2popx.js"]);
		expect(scripts.inline).toEqual([
			"\n      window.__START_TIME__ = performance.now();\n    ",
			'document.title = "a < b && c > d";',
		]);

		// Expected values are `openssl dgst -sha256 -binary | base64` of each text.
		expect(scripts.inline.map(inlineScriptSource)).toEqual([
			"'sha256-cPEL03JTu8LPLdqcqAwuHzYQQLSPMumTLbwpPD60V/c='",
			"'sha256-xC8eVtK9EuTrfkOVEa+wDJNl515pFpdMdV1kKCVUPZ8='",
		]);
		// A browser hashes the script with its line breaks as line feeds.
		expect(
			readScripts(html.replaceAll("\n", "\r\n")).inline.map(inlineScriptSource),
		).toEqual([
			"'sha256-cPEL03JTu8LPLdqcqAwuHzYQQLSPMumTLbwpPD60V/c='",
			"'sha256-xC8eVtK9EuTrfkOVEa+wDJNl515pFpdMdV1kKCVUPZ8='",
		]);

		const policy = contentSecurityPolicy("https://api.example.com", [
			...scripts.inline,
			...scripts.inline,
		]);
		expect(policy.split("; ")).toContain(
			"script-src 'self' 'sha256-cPEL03JTu8LPLdqcqAwuHzYQQLSPMumTLbwpPD60V/c=' 'sha256-xC8eVtK9EuTrfkOVEa+wDJNl515pFpdMdV1kKCVUPZ8=' 'wasm-unsafe-eval'",
		);
	});

	test("the policy names the backend and nothing looser", () => {
		const directives = contentSecurityPolicy(
			"https://api.example.com",
			[],
		).split("; ");
		expect(directives).toContain("default-src 'self'");
		expect(directives).toContain("script-src 'self' 'wasm-unsafe-eval'");
		expect(directives).toContain(
			"connect-src 'self' https://api.example.com wss://api.example.com data: blob: https://api.klipy.com https://fonts.googleapis.com https://fonts.gstatic.com",
		);
		expect(directives).toContain("form-action 'self' https://api.example.com");
		expect(directives).toContain("frame-ancestors 'self'");
		expect(directives).toContain("base-uri 'self'");
		expect(directives).toContain("object-src 'none'");
		expect(directives).toContain("worker-src 'self' blob:");

		for (const directive of directives) {
			const sources = directive.split(" ").slice(1);
			expect(sources).not.toContain("*");
			expect(sources).not.toContain("https:");
			expect(sources).not.toContain("'unsafe-eval'");
		}
		const scriptSources = directives.find((directive) =>
			directive.startsWith("script-src "),
		);
		expect(scriptSources).not.toContain("'unsafe-inline'");
	});

	test("malformed inputs are refused", () => {
		expect(parseBasePath("/workspace")).toBe("/workspace");
		expect(parseBasePath("/team/app")).toBe("/team/app");
		for (const basePath of [
			"",
			"/",
			"workspace",
			"/workspace/",
			"/work space",
			"/workspace/../x",
			"https://example.com/workspace",
		]) {
			expect(() => parseBasePath(basePath)).toThrow();
		}

		expect(parseBackendOrigin("https://api.example.com")).toBe(
			"https://api.example.com",
		);
		expect(parseBackendOrigin("https://api.example.com:8443")).toBe(
			"https://api.example.com:8443",
		);
		for (const origin of [
			"",
			"api.example.com",
			"http://api.example.com",
			"https://api.example.com/",
			"https://api.example.com/api",
			"https://API.example.com",
			"wss://api.example.com",
		]) {
			expect(() => parseBackendOrigin(origin)).toThrow();
		}
	});

	test("the upload order publishes pages after everything they load", () => {
		expect(
			uploadOrder([
				"app-CZp2popx.js",
				"assets/katex-B7QeSwCL.css",
				"canvas-render.html",
				"index.html",
				"manifest.json",
				"pipedream-connect.html",
				"sw.js",
			]),
		).toEqual([
			"app-CZp2popx.js",
			"assets/katex-B7QeSwCL.css",
			"manifest.json",
			"sw.js",
			".htaccess",
			"canvas-render.html",
			"index.html",
			"pipedream-connect.html",
		]);
	});

	test("a bundle is packaged only for the folder and backend it was built for", () => {
		const root = mkdtempSync(join(tmpdir(), "supamac-package-web-test-"));
		try {
			const dist = join(root, "dist");
			mkdirSync(join(dist, "assets"), { recursive: true });
			mkdirSync(join(dist, "web-hosted"));
			writeFileSync(
				join(dist, "index.html"),
				'<!doctype html><script type="module" crossorigin src="/workspace/app-CZp2popx.js"></script><script>window.__START_TIME__ = performance.now();</script>',
			);
			writeFileSync(
				join(dist, "app-CZp2popx.js"),
				"const origin=`https://api.example.com`;",
			);
			writeFileSync(join(dist, "app-CZp2popx.js.map"), "{}");
			writeFileSync(join(dist, "assets", "katex-B7QeSwCL.css"), "a{}");
			writeFileSync(join(dist, "web-hosted", "databases-C9a9ytc_.mp4"), "v");
			writeFileSync(join(dist, "manifest.json"), "{}");

			expect(() =>
				assertBuiltFor(dist, "/app", "https://api.example.com"),
			).toThrow("MACRO_APP_BASE_PATH=/app");
			expect(() =>
				assertBuiltFor(dist, "/work", "https://api.example.com"),
			).toThrow("MACRO_APP_BASE_PATH=/work");
			expect(() =>
				assertBuiltFor(dist, "/workspace", "https://other.example.com"),
			).toThrow("VITE_BACKEND_ORIGIN=https://other.example.com");
			// The bundle's origin only starts with this one.
			expect(() =>
				assertBuiltFor(dist, "/workspace", "https://api.example.co"),
			).toThrow("VITE_BACKEND_ORIGIN=https://api.example.co");
			expect(() =>
				assertBuiltFor(join(root, "absent"), "/workspace", "https://x.test"),
			).toThrow("build the web app first");
			assertBuiltFor(dist, "/workspace", "https://api.example.com");

			// A bundle built for a deeper folder loads its script from below the
			// folder asked for, where the bundle holds no such file.
			const deep = join(root, "deep");
			mkdirSync(deep);
			writeFileSync(
				join(deep, "index.html"),
				'<!doctype html><script type="module" crossorigin src="/team/app/app-CZp2popx.js"></script>',
			);
			writeFileSync(
				join(deep, "app-CZp2popx.js"),
				"const origin=`https://api.example.com`;",
			);
			expect(() =>
				assertBuiltFor(deep, "/team", "https://api.example.com"),
			).toThrow("MACRO_APP_BASE_PATH=/team");
			assertBuiltFor(deep, "/team/app", "https://api.example.com");

			const options = {
				dist,
				basePath: "/workspace",
				backendOrigin: "https://api.example.com",
				enforceCsp: false,
				omitVideos: false,
				keepSourceMaps: false,
			};
			for (const refused of [
				{ ...options, basePath: "workspace" },
				{ ...options, backendOrigin: "http://api.example.com" },
				{ ...options, basePath: "/app" },
				{ ...options, backendOrigin: "https://other.example.com" },
			]) {
				const out = join(root, "refused");
				expect(() => packageWeb({ ...refused, out })).toThrow();
				expect(existsSync(out)).toBe(false);
			}

			const out = join(root, "site");
			const result = packageWeb({ ...options, out });
			expect(listFiles(out)).toEqual([
				".htaccess",
				"app-CZp2popx.js",
				"assets/katex-B7QeSwCL.css",
				"index.html",
				"manifest.json",
				"web-hosted/databases-C9a9ytc_.mp4",
			]);
			expect(result.bundle.files).toBe(6);
			expect(result.published.files).toBe(6);
			expect(result.manifest).toBe(join(root, "site.publish.json"));
			expect(JSON.parse(readFileSync(result.manifest, "utf8"))).toEqual({
				basePath: "/workspace",
				backendOrigin: "https://api.example.com",
				contentSecurityPolicy: "report-only",
				upload: [
					"app-CZp2popx.js",
					"assets/katex-B7QeSwCL.css",
					"manifest.json",
					"web-hosted/databases-C9a9ytc_.mp4",
					".htaccess",
					"index.html",
				],
			});
			const rules = readFileSync(join(out, ".htaccess"), "utf8");
			expect(rules).toContain("Content-Security-Policy-Report-Only");
			expect(rules).toContain(
				"script-src 'self' 'sha256-rCIk6xtJ7Ig3dLwfcVliek0QtvXwTuILfBKntVcGaKk=' 'wasm-unsafe-eval'",
			);
			// The cache rule names the extensions of the files that are published:
			// the source maps were left out.
			expect(rules).toContain(
				'<FilesMatch "-[A-Za-z0-9_-]{8}\\.(css|js|mp4)$">\n',
			);

			// A folder that already holds a package is not written into again.
			expect(() => packageWeb({ ...options, out })).toThrow("is not empty");

			const lean = join(root, "lean");
			packageWeb({
				...options,
				out: lean,
				enforceCsp: true,
				omitVideos: true,
				keepSourceMaps: true,
			});
			expect(listFiles(lean)).toEqual([
				".htaccess",
				"app-CZp2popx.js",
				"app-CZp2popx.js.map",
				"assets/katex-B7QeSwCL.css",
				"index.html",
				"manifest.json",
			]);
			const leanRules = readFileSync(join(lean, ".htaccess"), "utf8");
			expect(leanRules).not.toContain("Report-Only");
			expect(leanRules).toContain(
				'<FilesMatch "-[A-Za-z0-9_-]{8}\\.(css|js|js\\.map)$">\n',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
