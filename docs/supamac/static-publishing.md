# Publishing the web app on static hosting

The web app can be published as plain files in a sub-folder of a site, on
shared hosting that reads `.htaccess` (Apache, LiteSpeed) and runs no server
code. The backend runs elsewhere on one https origin with a path prefix per
service. `bun run supamac:package-web` turns a built bundle into the folder to
upload, with the server rules the app needs. It uploads nothing.

Examples use `/workspace` for the folder and `https://api.example.com` for the
backend.

## A folder is not an origin

A sub-folder shares its origin with every other page of the site. The app
keeps its access and refresh tokens in the browser's `localStorage`, which any
script running on that origin can read. The headers below are sent with the
folder's own files only, so they do not protect those tokens from a page
elsewhere on the site. Publish the folder on a site that serves nothing else,
or give the app a subdomain of its own: that is the real isolation.

## Build

Two build inputs make a bundle for a self-hosted instance. Set both in the
environment of the build, not in a `.env` file: `index.html` is written from
the process environment.

| Input | Meaning |
| --- | --- |
| `MACRO_APP_BASE_PATH` | The folder the bundle is served from, such as `/workspace`. Default `/app`. |
| `VITE_BACKEND_ORIGIN` | The backend's https origin, with no path. Set, the bundle addresses every service under it and loads no upstream analytics. |

```sh
cd apps/web
MODE=production NODE_ENV=production NODE_OPTIONS=--max-old-space-size=8192 \
  MACRO_APP_BASE_PATH=/workspace VITE_BACKEND_ORIGIN=https://api.example.com \
  bun run --bun build
```

The build needs the WebAssembly packages (`just build-wasm` in `apps/web`,
which needs the Rust toolchain and `wasm-pack`).

## Package

```sh
bun run supamac:package-web --dist apps/web/dist --base-path /workspace \
  --backend-origin https://api.example.com --out /tmp/workspace-site
```

The tool copies the bundle to the output folder, writes `.htaccess` at its
root, and writes the upload order beside the folder, in
`/tmp/workspace-site.publish.json`. It prints the file count and size of the
bundle and of the folder.

| Flag | Effect |
| --- | --- |
| `--omit-videos` | Leaves out `web-hosted/`, the tutorial videos (about 105 MB). The tutorial dialogs then have nothing to play. |
| `--keep-source-maps` | Publishes the `*.map` files, which are left out by default. |
| `--enforce-csp` | Sends the Content Security Policy as an enforced header. The default is report-only. |

It refuses to run, with a non-zero exit, when:

- the base path or the backend origin is malformed (the same rules as the build);
- `index.html` loads no script that is a file of the bundle under the base
  path, so the bundle was built for another folder. A deeper folder counts:
  a bundle built for `/team/app` is refused for `/team`;
- no script contains the backend origin, so the bundle was built without
  `VITE_BACKEND_ORIGIN` or for another backend. Such a bundle calls the
  upstream hosts and loads their analytics;
- the output folder already holds files.

## What the `.htaccess` does

Routing, as upstream's own hosting does it:

- `/workspace` redirects to `/workspace/`. Apache's documentation says the
  server sends this redirect itself for a folder and skips the folder's rules
  for that one address; the rule in the file is for a server that reads them.
- A file that exists is served.
- A missing path whose last segment has a file extension is left to the
  server, which answers with its own 404 page, unless the path contains `@`.
  The app recovers when a script it needs is gone after a new publish, which
  only works if the answer is an error and not the app's page.
- Every other path is `index.html`, so a link to any screen works.

Caching:

- Content-hashed files (`name-<hash>.<ext>`) are `public, max-age=31536000,
  immutable`. The pattern lists the extensions those files have in the bundle.
  It goes by the name alone: a file added to `apps/web/public` with a name of
  that shape, such as `icon-maskable.png` (a dash, eight characters, an
  extension the bundle hashes), would be cached for a year. No such file
  exists today.
- `*.html`, `*.json`, `*.txt` and `sw.js` name the current build and are
  `no-store`.
- Every other file (icons, sounds) is `no-cache`: stored, and checked with
  the server on each use.
- A 404 is given no `Cache-Control`. The cache rules use `Header set`, which
  Apache documents as added to successful answers only, and an `always` rule
  beside them would send two values with every file. Upstream answers a
  missing file with `no-store`; here a CDN in front decides for itself how
  long to keep a 404, which is why the publish order below matters.

Headers on every response:

- `.wasm` is served as `application/wasm`.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy:
  same-origin-allow-popups`, `X-Frame-Options: SAMEORIGIN`.
- `Permissions-Policy` keeps the camera, the microphone and screen capture
  for calls, and turns off sensors and device ports the app never asks for.
- The Content Security Policy. Scripts load from the site only, plus the
  inline scripts of the built HTML files by their sha256 hash, plus
  WebAssembly. Requests go to the site, the backend (https and wss) and the
  third parties below. Each source is listed with its reason in
  `contentSecurityPolicy` in `tooling/supamac/package-web.ts`.

The policy leaves these third-party hosts reachable from the browser, because
the app's source uses each one. Remove a host from `contentSecurityPolicy` to
cut the feature off:

| Host | What uses it |
| --- | --- |
| `api.klipy.com`, `static.klipy.com` | The GIF picker: its search requests and the GIFs it shows |
| `github.com`, `avatars.githubusercontent.com` | Avatars on pull requests |
| `fonts.googleapis.com`, `fonts.gstatic.com` | Fonts for the text of opened design files |
| `www.youtube-nocookie.com` | The tour videos |
| `www.loom.com`, `supercut.ai` | Video players in link previews |
| `pipedream.com` | The connector sign-in frame |

No `Strict-Transport-Security` header is set: it would bind the whole host,
not only the folder.

## Publish order

Upload the files in the order `upload` gives in the `.publish.json` file:

1. every file except `.htaccess` and the HTML files;
2. `.htaccess`;
3. the HTML files.

A page must never name a file that is not there yet: a CDN in front of the
host can cache the 404 for minutes. The rules go before the pages because
they carry the hashes of the pages' inline scripts.

Leave the previous build's hashed files in place. Tabs that are still open
load their screens from them.

After the upload, check the answers with `curl -sI`, because a server that
ignores a directive does not say so:

| URL | Expect |
| --- | --- |
| `/workspace/` | 200, `cache-control: no-store`, the security headers |
| `/workspace/<any hashed .js from the folder>` | 200, `immutable` |
| `/workspace/assets/<any .wasm>` | `content-type: application/wasm` |
| `/workspace/missing-AbCd1234.js` | 404 |
| `/workspace/some/screen` | 200, `content-type: text/html` |

## From report-only to enforced

A policy that is too strict breaks the app without an error on screen, so the
first publish sends `Content-Security-Policy-Report-Only`. The browser then
blocks nothing and writes each violation to the console of its developer
tools.

1. Publish in report-only mode and use the features you rely on with the
   console open.
2. For each report, either add the source to `contentSecurityPolicy` in
   `tooling/supamac/package-web.ts` with its reason, or accept that the
   enforced policy will block it.
3. Package again with `--enforce-csp`. From the same build only `.htaccess`
   differs, so upload that file.

Known before you start:

- The bundled validation library compiles its checks with `new Function`
  while it is allowed to. In report-only mode that is reported as `script-src`
  / `eval` many times per page. Enforced, the library is refused once per
  page, which is still reported, and falls back to its interpreter. The
  policy does not allow `'unsafe-eval'` to silence the report; the library's
  own `jitless` setting, set in the web app, is what removes it.
- Artifact previews and the HTML preview of code blocks are `srcdoc` frames
  that run inline scripts. Such a frame inherits the page's policy, so the
  enforced policy stops those scripts. Keep the policy report-only while you
  need them.
- The backend is one origin in the policy. A call media server or an object
  store that the backend hands to the browser on another host is blocked
  when enforced; route it under the backend origin, or add it to the policy.
- Remote background images in a mail's own CSS are blocked. Images in mail
  come through the backend's image proxy.
- A profile picture or bot avatar saved as a link to another host is blocked.
  Pictures the backend serves are not.

## What was verified

Checked in this repository, with a production build for `/workspace` and
`https://api.example.com`, headless Chromium, and a small static server that
applies the same routing rules and sends the headers read from the generated
`.htaccess`:

- `bun test tooling/supamac` passes.
- Packaging a real build: 3082 files (352.5 MB) became 1745 files (215.9 MB),
  and 1728 files (111.3 MB) with `--omit-videos`.
- A bundle whose `index.html` loads `/team/app/app-<hash>.js` was refused for
  `/team` and packaged for `/team/app`.
- The stand-in server gave the answers in the table above. It reads the
  headers from the generated file but routes and chooses content types
  itself, so the rewrite rules and `AddType` were not exercised.
- With the policy enforced, the welcome page, the login page and the email
  sign-in form rendered. The only violation was `script-src` / `eval`, once
  per page load, from the validation library's check described above. In
  report-only mode the same pages reported it 14 times per load and nothing
  else. `canvas-render.html` loaded with the same single violation and
  `pipedream-connect.html` with none.
- With that one check patched, in a scratch copy of the bundle, to read as if
  the library's `jitless` setting were on, the same pages reported no
  violation under the enforced policy. The setting itself is not set in the
  web app.
- Under the enforced policy a WebAssembly module from the bundle compiled, a
  blob worker ran, and blob and data images loaded; a third-party image, a
  third-party request, `eval` and an inline event handler were blocked; an
  inline script in a sandboxed `srcdoc` frame did not run.

Not verified:

- LiteSpeed and Apache. Neither was available, so no rewrite rule in the file
  has run on a real server. Unknown there: that a missing file the rules
  leave alone gets the server's 404 and not a page from the site root's own
  rules or error document; whether `FilesMatch` headers override the folder's
  default; `Header always set`; `AddType`; which of the server and the rule
  redirects the folder's slash-less address; the effect of an `.htaccess` in
  the site root; whether a CDN passes the headers through; and whether
  `.wasm` and `.js` are compressed.
- What a 404 carries on a real server, and how long a CDN in front keeps it.
- Any signed-in screen. Every source in the policy beyond what the signed-out
  pages load comes from reading the app's source, not from running it.
- A real backend. The signed-out pages made no backend request.
- `just build-wasm`. The WebAssembly packages were already built here.
