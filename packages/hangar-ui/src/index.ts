/**
 * `@crewhaus/hangar-ui` — the Hangar console's static UI, embedded as text.
 *
 * Zero-build by design: the `assets/` tree is hand-written browser code
 * (plain ES modules + one CSS file + one HTML shell, no framework, no npm
 * deps, no bundler). This module imports every asset `with { type: "text" }`
 * and exports them keyed by serve path, which is the exact map the CLI hands
 * to the hangar server's static-asset option.
 *
 * STATIC imports only, deliberately: `bun build --compile` embeds only what
 * the import graph references statically — a runtime `readFileSync` of a
 * package-relative path resolves under `/$bunfs` in the compiled binary,
 * where the files were never placed, and bricks every command at boot. The
 * checked-in asset files stay the single source of truth; this module only
 * re-exports their text.
 *
 * The unit tests enforce the embed map's completeness (every file under
 * `assets/` appears under its serve path, with the right content type, and
 * every relative import inside the JS modules resolves within the map), so
 * adding an asset file without registering it here fails CI.
 */
import hangarCss from "../assets/hangar.css" with { type: "text" };
// bun-types declares `*.html` imports as HTMLBundle (Bun's HTML-bundle
// feature) and that ambient wins over a local one, but the `type: "text"`
// import attribute makes this a plain string at runtime — hence the cast.
import indexHtmlBundle from "../assets/index.html" with { type: "text" };
import apiJs from "../assets/js/api.js" with { type: "text" };
import appJs from "../assets/js/app.js" with { type: "text" };
import domJs from "../assets/js/dom.js" with { type: "text" };
import markdownJs from "../assets/js/markdown.js" with { type: "text" };
import routerJs from "../assets/js/router.js" with { type: "text" };
import routesJs from "../assets/js/routes.js" with { type: "text" };
import shapesJs from "../assets/js/shapes.js" with { type: "text" };
import supervisionJs from "../assets/js/supervision.js" with { type: "text" };
import utilJs from "../assets/js/util.js" with { type: "text" };
import activityViewJs from "../assets/js/views/activity.js" with { type: "text" };
import approvalsViewJs from "../assets/js/views/approvals.js" with { type: "text" };
import controlViewJs from "../assets/js/views/control.js" with { type: "text" };
import costsViewJs from "../assets/js/views/costs.js" with { type: "text" };
import deployViewJs from "../assets/js/views/deploy.js" with { type: "text" };
import evalsViewJs from "../assets/js/views/evals.js" with { type: "text" };
import inboxViewJs from "../assets/js/views/inbox.js" with { type: "text" };
import jobsViewJs from "../assets/js/views/jobs.js" with { type: "text" };
import libraryViewJs from "../assets/js/views/library.js" with { type: "text" };
import memoryViewJs from "../assets/js/views/memory.js" with { type: "text" };
import overviewViewJs from "../assets/js/views/overview.js" with { type: "text" };
import procViewJs from "../assets/js/views/proc.js" with { type: "text" };
import reviewViewJs from "../assets/js/views/review.js" with { type: "text" };
import runsViewJs from "../assets/js/views/runs.js" with { type: "text" };
import schedulersViewJs from "../assets/js/views/schedulers.js" with { type: "text" };
import sessionsViewJs from "../assets/js/views/sessions.js" with { type: "text" };
import specViewJs from "../assets/js/views/spec.js" with { type: "text" };
import tokenViewJs from "../assets/js/views/token.js" with { type: "text" };

/** One embeddable asset: the file's text plus its HTTP content type. */
export type HangarAsset = {
  readonly body: string;
  readonly contentType: string;
};

/** Extension → content type for everything the asset tree may contain. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/** Content type for a serve path by extension (octet-stream fallback). */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const indexHtml = indexHtmlBundle as unknown as string;

function asset(body: string, path: string): HangarAsset {
  return { body, contentType: contentTypeFor(path) };
}

/**
 * The embed map, keyed by serve path. `"/"` is the SPA shell (the app is a
 * hash router, so `/` is the only HTML route); everything else lives under
 * `/assets/…` exactly as laid out on disk.
 */
export const hangarAssets: Readonly<Record<string, HangarAsset>> = {
  "/": asset(indexHtml, "index.html"),
  "/assets/hangar.css": asset(hangarCss, "hangar.css"),
  "/assets/js/app.js": asset(appJs, "app.js"),
  "/assets/js/api.js": asset(apiJs, "api.js"),
  "/assets/js/dom.js": asset(domJs, "dom.js"),
  "/assets/js/markdown.js": asset(markdownJs, "markdown.js"),
  "/assets/js/router.js": asset(routerJs, "router.js"),
  "/assets/js/routes.js": asset(routesJs, "routes.js"),
  "/assets/js/shapes.js": asset(shapesJs, "shapes.js"),
  "/assets/js/supervision.js": asset(supervisionJs, "supervision.js"),
  "/assets/js/util.js": asset(utilJs, "util.js"),
  "/assets/js/views/activity.js": asset(activityViewJs, "activity.js"),
  "/assets/js/views/approvals.js": asset(approvalsViewJs, "approvals.js"),
  "/assets/js/views/control.js": asset(controlViewJs, "control.js"),
  "/assets/js/views/costs.js": asset(costsViewJs, "costs.js"),
  "/assets/js/views/deploy.js": asset(deployViewJs, "deploy.js"),
  "/assets/js/views/evals.js": asset(evalsViewJs, "evals.js"),
  "/assets/js/views/inbox.js": asset(inboxViewJs, "inbox.js"),
  "/assets/js/views/jobs.js": asset(jobsViewJs, "jobs.js"),
  "/assets/js/views/library.js": asset(libraryViewJs, "library.js"),
  "/assets/js/views/memory.js": asset(memoryViewJs, "memory.js"),
  "/assets/js/views/overview.js": asset(overviewViewJs, "overview.js"),
  "/assets/js/views/proc.js": asset(procViewJs, "proc.js"),
  "/assets/js/views/review.js": asset(reviewViewJs, "review.js"),
  "/assets/js/views/runs.js": asset(runsViewJs, "runs.js"),
  "/assets/js/views/schedulers.js": asset(schedulersViewJs, "schedulers.js"),
  "/assets/js/views/sessions.js": asset(sessionsViewJs, "sessions.js"),
  "/assets/js/views/spec.js": asset(specViewJs, "spec.js"),
  "/assets/js/views/token.js": asset(tokenViewJs, "token.js"),
};
