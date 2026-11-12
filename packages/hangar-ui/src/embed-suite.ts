/**
 * The embed-map completeness + asset-hygiene suite.
 *
 * DELIBERATELY NOT NAMED `*.test.ts`: this suite must run in its OWN
 * process (`bun test ./src/embed-suite.ts`, the second half of the package
 * test script). Importing `./index` loads every asset file as TEXT
 * (`with { type: "text" }`), and bun's module registry keys a module by
 * path alone — the import attribute is not part of the key — so in a
 * process that ALSO imports an asset as an ES module (every view test),
 * whichever load happens first poisons the other: the ESM side dies with
 * "Export not found", or this side with "Missing 'default' export",
 * depending on nothing but file order. Two processes, two registries, no
 * collision — and `bun test src` skips this file because the name is off
 * the test glob.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_TYPES, EMBED_MODULES, contentTypeFor, hangarAssets } from "./index";

const ASSETS_DIR = join(import.meta.dir, "..", "assets");

/** `import … from "x"` and `export … from "x"`: what a module needs before it runs. */
const STATIC_IMPORT_RE = /import\s+[^"']*?["']([^"']+)["']/g;
/** `import("x")` with a literal path: what a module loads when it is asked to. */
const LITERAL_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
/** Any `import(` at all: each must be one of the literal ones above. */
const ANY_DYNAMIC_IMPORT_RE = /\bimport\s*\(/g;

/** A module's imports: the static ones, the literal dynamic ones, and how many
 *  dynamic ones are NOT a literal path (a computed import the walk cannot follow). */
function importsOf(body: string): {
  readonly statics: readonly string[];
  readonly lazy: readonly string[];
  readonly computed: number;
} {
  const statics = [...body.matchAll(STATIC_IMPORT_RE)].map((m) => m[1] ?? "");
  const lazy = [...body.matchAll(LITERAL_IMPORT_RE)].map((m) => m[1] ?? "");
  const all = [...body.matchAll(ANY_DYNAMIC_IMPORT_RE)].length;
  return { statics, lazy, computed: all - lazy.length };
}

/** Walk assets/ and return every file's path relative to it (posix slashes). */
function walkAssets(dir = ASSETS_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) out.push(...walkAssets(full, rel));
    else out.push(rel);
  }
  return out;
}

/** The serve path an asset file is expected to appear under. */
function servePathFor(rel: string): string {
  return rel === "index.html" ? "/" : `/assets/${rel}`;
}

describe("embed map completeness", () => {
  const files = walkAssets();

  test("assets tree is non-trivial", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain("index.html");
    expect(files).toContain("hangar.css");
    expect(files).toContain("js/app.js");
  });

  test("every M2 screen ships as an embedded module with the js content type", () => {
    const m2 = [
      "/assets/js/supervision.js",
      "/assets/js/views/proc.js",
      "/assets/js/views/runs.js",
      "/assets/js/views/control.js",
      "/assets/js/views/schedulers.js",
      "/assets/js/views/approvals.js",
      "/assets/js/views/review.js",
      "/assets/js/views/inbox.js",
      "/assets/js/views/activity.js",
      "/assets/js/views/jobs.js",
      "/assets/js/views/deploy.js",
    ];
    for (const key of m2) {
      const entry = hangarAssets[key];
      expect(`${key}:${entry !== undefined}`).toBe(`${key}:true`);
      expect(`${key}:${entry?.contentType}`).toBe(`${key}:text/javascript; charset=utf-8`);
      expect(`${key}:${(entry?.body.length ?? 0) > 0}`).toBe(`${key}:true`);
    }
  });

  test("every M3 area ships a view module (one per implementer area)", () => {
    const m3 = [
      "/assets/js/views/spec-edit.js",
      "/assets/js/views/memory-fabric.js",
      "/assets/js/views/evals-lab.js",
      "/assets/js/views/data.js",
      "/assets/js/views/feedback.js",
      "/assets/js/views/creds.js",
      "/assets/js/views/channels.js",
      "/assets/js/views/security.js",
      "/assets/js/views/thredz.js",
      "/assets/js/views/inspect.js",
      "/assets/js/views/runtime.js",
    ];
    for (const key of m3) {
      const entry = hangarAssets[key];
      expect(`${key}:${entry !== undefined}`).toBe(`${key}:true`);
      expect(`${key}:${entry?.contentType}`).toBe(`${key}:text/javascript; charset=utf-8`);
      expect(`${key}:${(entry?.body.length ?? 0) > 0}`).toBe(`${key}:true`);
    }
  });

  test("every file under assets/ is embedded under its serve path with exact bytes", () => {
    for (const rel of files) {
      const key = servePathFor(rel);
      const entry = hangarAssets[key];
      expect(entry).toBeDefined();
      const onDisk = readFileSync(join(ASSETS_DIR, rel), "utf8");
      expect(entry?.body).toBe(onDisk);
    }
  });

  test("the map holds nothing that is not on disk (no stale keys)", () => {
    const expected = files.map(servePathFor).sort();
    expect(Object.keys(hangarAssets).sort()).toEqual(expected);
  });

  test("content types are right per extension", () => {
    expect(hangarAssets["/"]?.contentType).toBe("text/html; charset=utf-8");
    expect(hangarAssets["/assets/hangar.css"]?.contentType).toBe("text/css; charset=utf-8");
    for (const [key, entry] of Object.entries(hangarAssets)) {
      if (key.endsWith(".js")) expect(entry.contentType).toBe("text/javascript; charset=utf-8");
    }
  });

  test("every body is non-empty", () => {
    for (const entry of Object.values(hangarAssets)) {
      expect(entry.body.length).toBeGreaterThan(0);
    }
  });
});

describe("the embed modules", () => {
  const modules = Object.entries(EMBED_MODULES);

  test("one per area, and no two claim the same path (a duplicate would hide an asset)", () => {
    expect(modules.map(([area]) => area).sort()).toEqual([
      "attention",
      "creation",
      "delegation",
      "home",
      "inspection",
      "integrations",
      "knowledge",
      "people",
      "quality",
      "runtime",
    ]);
    const sum = modules.reduce((n, [, map]) => n + Object.keys(map).length, 0);
    expect(Object.keys(hangarAssets).length).toBe(sum);
    const owner = new Map<string, string>();
    for (const [area, map] of modules) {
      for (const key of Object.keys(map)) {
        expect(`${key}:${owner.get(key) ?? area}`).toBe(`${key}:${area}`);
        owner.set(key, area);
      }
    }
  });

  test("index.ts spreads every embed module, and builds the map from nothing else", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const files = readdirSync(join(import.meta.dir, "embed"))
      .filter((name) => name.endsWith(".ts") && name !== "asset.ts")
      .map((name) => name.slice(0, -3))
      .sort();
    expect(files).toEqual(modules.map(([area]) => area).sort());
    for (const area of files) {
      expect(`${area}:${source.includes(`...${area}Assets,`)}`).toBe(`${area}:true`);
    }
    expect(source.match(/^import .* with \{ type: "text" \};$/gm) ?? []).toEqual([]);
  });

  test("no embed module imports index.ts back", () => {
    for (const name of readdirSync(join(import.meta.dir, "embed"))) {
      const source = readFileSync(join(import.meta.dir, "embed", name), "utf8");
      expect(`${name}:${/from\s+["']\.\.\/index["']/.test(source)}`).toBe(`${name}:false`);
    }
  });
});

describe("contentTypeFor", () => {
  test("known extensions", () => {
    expect(contentTypeFor("/assets/js/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("x.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("a.svg")).toBe("image/svg+xml");
  });

  test("unknown/none falls back to octet-stream", () => {
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
    expect(contentTypeFor("weird.wasm")).toBe("application/octet-stream");
  });

  test("CONTENT_TYPES covers every embedded extension", () => {
    for (const key of Object.keys(hangarAssets)) {
      if (key === "/") continue;
      const dot = key.lastIndexOf(".");
      expect(dot).toBeGreaterThan(0);
      expect(CONTENT_TYPES[key.slice(dot)]).toBeDefined();
    }
  });
});

describe("shell wiring", () => {
  test("index.html references the stylesheet and the module entry by serve path", () => {
    const html = hangarAssets["/"]?.body ?? "";
    expect(html).toContain('href="/assets/hangar.css"');
    expect(html).toContain('src="/assets/js/app.js"');
    expect(html).toContain('type="module"');
  });

  test("index.html defaults to the dark theme", () => {
    expect(hangarAssets["/"]?.body ?? "").toContain('data-theme="dark"');
  });
});

describe("js module hygiene", () => {
  const jsEntries = Object.entries(hangarAssets).filter(([key]) => key.endsWith(".js"));

  test("every js asset parses as a valid module (zero-build means no compile step to catch this)", () => {
    const transpiler = new Bun.Transpiler({ loader: "js" });
    for (const [key, entry] of jsEntries) {
      let failed = "";
      try {
        transpiler.transformSync(entry.body);
      } catch (err) {
        failed = `${key}: ${err instanceof Error ? err.message : String(err)}`;
      }
      expect(failed).toBe("");
    }
  });

  test("no innerHTML anywhere (injection-safe DOM building only)", () => {
    for (const [key, entry] of jsEntries) {
      expect(`${key}:${entry.body.includes("innerHTML")}`).toBe(`${key}:false`);
    }
  });

  test("no markup-string assignment of any kind (the ban is wider than innerHTML)", () => {
    // Built from parts so this test file cannot itself trip a scanner.
    const banned = [
      "outer" + "HTML",
      "insertAdjacent" + "HTML",
      "document." + "write",
      "createContextual" + "Fragment",
      "DOM" + "Parser",
    ];
    for (const [key, entry] of jsEntries) {
      for (const needle of banned) {
        expect(`${key}:${needle}:${entry.body.includes(needle)}`).toBe(`${key}:${needle}:false`);
      }
    }
  });

  test("no module sets srcdoc, and the one frame carries a sandbox", () => {
    // A plugin pane is the one place third-party markup is shown, and it is
    // shown in a sandboxed frame (opaque origin, no `allow-same-origin`) that
    // loads the pane from a single-use address serving the plugin's own
    // policy. `srcdoc` would hand the frame this console's policy instead, so
    // no module may set it.
    const setsSrcdoc = /["']srcdoc["']|\.srcdoc\s*=/;
    const users = jsEntries.filter(([, entry]) => setsSrcdoc.test(entry.body)).map(([key]) => key);
    expect(users).toEqual([]);
    // The check itself can fail.
    expect(setsSrcdoc.test('frame.setAttribute("srcdoc", doc)')).toBe(true);
    const panes = hangarAssets["/assets/js/views/panes.js"]?.body ?? "";
    expect(panes).toContain("sandbox:");
    // …and it is the ONLY module allowed to build an iframe at all: the
    // sandbox is what makes the exception safe, so a frame appearing
    // elsewhere would be one nobody had to think about.
    const frames = jsEntries
      .filter(([, entry]) => entry.body.includes('el("iframe"'))
      .map(([key]) => key);
    expect(frames).toEqual(["/assets/js/views/panes.js"]);
    // The sandbox token list itself (never `allow-same-origin` alongside
    // `allow-scripts`) is proven behaviourally in `m4-views.test.ts`, where
    // `paneSandbox` is called with a payload that tries to widen it.
  });

  test("no module hardcodes a `harness scan-root` verb (the CLI has none)", () => {
    // The console's CLI twins are its trust affordance: a command shown
    // beside a button has to be one a terminal accepts. `crewhaus harness`
    // takes list|show|add|remove|relocate|group|tag|pin|scan|preflight — a
    // scan root is added by `harness scan --root <dir>`, which remembers the
    // root before it walks it. A twin nobody can paste teaches the opposite
    // of what the discipline is for, and the first-boot screen is where an
    // operator learns whether to believe them.
    for (const [key, entry] of jsEntries) {
      expect(`${key}:${entry.body.includes("scan-root add")}`).toBe(`${key}:false`);
    }
  });

  test("the evaluating notifications GET has exactly one caller, and the app runs it", () => {
    // `GET /api/notifications` IS the rules evaluation (HM-183: the manager
    // runs no timer). Every delivery it returns is added to the server's
    // dedupe set and never returned again — so a second caller does not read
    // the same state, it CONSUMES it, and the toast for whatever it ate can
    // never appear again in that manager process. One caller, therefore, and
    // every screen that needs the state goes through it.
    const callers = jsEntries
      .filter(([, entry]) => entry.body.includes("api.notifications("))
      .map(([key]) => key);
    expect(callers).toEqual(["/assets/js/notify.js"]);
    // …and the app must actually START that loop: a poll nobody runs is the
    // boot-time read this whole arrangement exists to replace.
    expect(hangarAssets["/assets/js/app.js"]?.body ?? "").toContain("notifications.start()");
  });

  test("every relative import resolves to another embedded asset (import-graph closure)", () => {
    let lazy = 0;
    for (const [key, entry] of jsEntries) {
      const dir = key.slice(0, key.lastIndexOf("/"));
      const found = importsOf(entry.body);
      lazy += found.lazy.length;
      for (const spec of [...found.statics, ...found.lazy]) {
        expect(`${key}: ${spec}:${spec.startsWith("./") || spec.startsWith("../")}`).toBe(
          `${key}: ${spec}:true`,
        );
        const resolved = resolvePosix(dir, spec);
        expect(`${key}: ${spec}:${hangarAssets[resolved] !== undefined}`).toBe(
          `${key}: ${spec}:true`,
        );
      }
    }
    // The tables load their screens lazily, so the walk has lazy edges to follow.
    expect(lazy).toBeGreaterThanOrEqual(30);
  });

  test("every dynamic import names a literal path, so the walk can follow it", () => {
    for (const [key, entry] of jsEntries) {
      expect(`${key}:${importsOf(entry.body).computed}`).toBe(`${key}:0`);
    }
    // The check itself can fail: a planted computed import is counted, a literal one is not.
    const planted = 'const name = "x"; await import(`./views/${name}.js`); import("./views/a.js");';
    expect(importsOf(planted)).toEqual({ statics: [], lazy: ["./views/a.js"], computed: 1 });
    expect(importsOf("const m = import (path);").computed).toBe(1);
  });

  test("no orphaned module is shipped (every js asset is reachable from the shell entry)", () => {
    // R-20: `pending.js` — the stub-era "not built yet" screen — outlived its
    // last importer and was still embedded, served over HTTP and compiled
    // into the single-binary CLI, with a docblock telling readers that
    // eleven live screens "have no data behind them yet". A dead module in a
    // zero-build tree has nothing to catch it: the transpiler, the
    // completeness check and the import-graph closure above all pass on code
    // nobody imports. Reachability is the check that does not.
    const seen = closureOf("/assets/js/app.js", { lazy: true });
    const orphans = jsEntries.map(([key]) => key).filter((key) => !seen.has(key));
    expect(orphans).toEqual([]);
  });

  test("the shell loads no screen up front: of the views, only the sign-in screen is static", () => {
    // Every other screen loads when it is first opened, through its table row.
    const eager = [...closureOf("/assets/js/app.js", { lazy: false })]
      .filter((key) => key.startsWith("/assets/js/views/"))
      .sort();
    expect(eager).toEqual(["/assets/js/views/sign-in.js"]);
    // Home pulls in none of the heavy screens either, so a cold visit stays light.
    const home = [...closureOf("/assets/js/views/home.js", { lazy: false })];
    expect(home.length).toBeGreaterThan(3);
    for (const heavy of ["evals", "spec-edit", "memory-fabric", "thredz", "runs"]) {
      expect(home).not.toContain(`/assets/js/views/${heavy}.js`);
    }
    // …and the lazy walk does reach the screens, so the check above can fail.
    const all = [...closureOf("/assets/js/app.js", { lazy: true })].filter((key) =>
      key.startsWith("/assets/js/views/"),
    );
    expect(all.length).toBeGreaterThanOrEqual(30);
  });

  test("no module outside views/ imports a screen statically", () => {
    for (const [key, entry] of jsEntries) {
      if (key.startsWith("/assets/js/views/")) continue;
      const dir = key.slice(0, key.lastIndexOf("/"));
      const views = importsOf(entry.body)
        .statics.map((spec) => resolvePosix(dir, spec))
        .filter((resolved) => resolved.startsWith("/assets/js/views/"));
      // app.js holds the sign-in screen, which has to be ready before the router starts.
      const allowed = key === "/assets/js/app.js" ? ["/assets/js/views/sign-in.js"] : [];
      expect(`${key}:${JSON.stringify(views)}`).toBe(`${key}:${JSON.stringify(allowed)}`);
    }
  });

  /** The modules whose body contains `needle`, sorted. */
  const holders = (needle: string | RegExp): string[] =>
    jsEntries
      .filter(([, entry]) =>
        typeof needle === "string" ? entry.body.includes(needle) : needle.test(entry.body),
      )
      .map(([key]) => key)
      .sort();

  test("every overlay is the one dialog primitive: no second modal can come back", () => {
    // The scan must have something to scan, or every "nowhere" below holds.
    expect(jsEntries.length).toBeGreaterThanOrEqual(60);
    expect(holders(/el\(\s*"dialog"/)).toEqual(["/assets/js/ui/dialog.js"]);
    expect(holders('role: "dialog"')).toEqual([]);
    expect(holders("modal-backdrop")).toEqual([]);
    expect(holders(".showModal(")).toEqual(["/assets/js/ui/dialog.js"]);
  });

  test("one assertive region, in the live-region module, and no other alert", () => {
    expect(holders('role: "alert"')).toEqual(["/assets/js/ui/live.js"]);
    expect(holders('"aria-live": "assertive"')).toEqual(["/assets/js/ui/live.js"]);
  });

  test("the only key listener on the document is the app's: inbox keys belong to their list", () => {
    expect(holders('document.addEventListener("keydown"')).toEqual(["/assets/js/app.js"]);
    expect(holders(/(window|globalThis)\.addEventListener\("keydown"/)).toEqual([]);
  });

  test("no module passes a style string, which a strict style policy would block", () => {
    const strings = holders(/style:\s*["'`]/);
    expect(strings).toEqual([]);
    // …and the components do set styles, through objects, so the scan can see them.
    expect(holders(/style: shapeAccentVars\(/).length).toBeGreaterThanOrEqual(3);
  });

  test("no interaction needs dragging (WCAG 2.5.7): nothing can be dragged at all", () => {
    expect(holders("draggable")).toEqual([]);
    expect(holders("dragstart")).toEqual([]);
    expect(holders("pointerdown")).toEqual([]);
  });

  test("browser modules never import bun/node builtins", () => {
    for (const [key, entry] of jsEntries) {
      expect(`${key}:${/from\s+["'](?:bun|node:)/.test(entry.body)}`).toBe(`${key}:false`);
    }
  });
});

/** Every module reachable from `entry`; `lazy` follows literal dynamic imports too. */
function closureOf(entry: string, opts: { readonly lazy: boolean }): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    const body = hangarAssets[key]?.body ?? "";
    const dir = key.slice(0, key.lastIndexOf("/"));
    const found = importsOf(body);
    for (const spec of opts.lazy ? [...found.statics, ...found.lazy] : found.statics) {
      const resolved = resolvePosix(dir, spec);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return seen;
}

function resolvePosix(fromDir: string, spec: string): string {
  const parts = fromDir.split("/").filter((p) => p !== "");
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}
