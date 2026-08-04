import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_TYPES, contentTypeFor, hangarAssets } from "./index";

const ASSETS_DIR = join(import.meta.dir, "..", "assets");

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
    ];
    for (const [key, entry] of jsEntries) {
      for (const needle of banned) {
        expect(`${key}:${needle}:${entry.body.includes(needle)}`).toBe(`${key}:${needle}:false`);
      }
    }
  });

  test("every relative import resolves to another embedded asset (import-graph closure)", () => {
    const importRe = /import\s+[^"']*?["']([^"']+)["']/g;
    for (const [key, entry] of jsEntries) {
      const dir = key.slice(0, key.lastIndexOf("/"));
      for (const match of entry.body.matchAll(importRe)) {
        const spec = match[1] ?? "";
        expect(spec.startsWith("./") || spec.startsWith("../")).toBe(true);
        const resolved = resolvePosix(dir, spec);
        expect(hangarAssets[resolved]).toBeDefined();
      }
    }
  });

  test("browser modules never import bun/node builtins", () => {
    for (const [key, entry] of jsEntries) {
      expect(`${key}:${/from\s+["'](?:bun|node:)/.test(entry.body)}`).toBe(`${key}:false`);
    }
  });
});

function resolvePosix(fromDir: string, spec: string): string {
  const parts = fromDir.split("/").filter((p) => p !== "");
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}
