import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type EmbeddedAsset, assetSmokeCheck, problemSummary } from "./hangar-smoke";

/** What the planted server serves; each test edits a copy of the asset map it checks. */
const ASSETS: Readonly<Record<string, EmbeddedAsset>> = {
  "/": {
    body: "<!doctype html><title>Hangar — CrewHaus</title>",
    contentType: "text/html; charset=utf-8",
  },
  "/assets/hangar.css": {
    body: "body { color: black; }\n",
    contentType: "text/css; charset=utf-8",
  },
  "/assets/js/app.js": {
    body: "export const é = '✓';\n",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/icon.svg": {
    body: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    contentType: "image/svg+xml",
  },
};

/** How the planted server deviates from the map, per path. */
type Fault = { drop?: true; contentType?: string; truncate?: true };
let faults: Record<string, Fault> = {};
let server: ReturnType<typeof Bun.serve> | undefined;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const asset = ASSETS[path];
      const fault = faults[path] ?? {};
      if (asset === undefined || fault.drop) return new Response("not found", { status: 404 });
      const body = fault.truncate ? asset.body.slice(0, -2) : asset.body;
      return new Response(body, {
        headers: { "content-type": fault.contentType ?? asset.contentType },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

const get = (path: string): Promise<Response> => fetch(`${base}${path}`);

describe("assetSmokeCheck", () => {
  test("every key served whole with its content type: ok, counting each key", async () => {
    faults = {};
    expect(await assetSmokeCheck(get, ASSETS)).toEqual({ ok: true, count: 4 });
  });

  test("a key missing from what is served is named", async () => {
    faults = { "/assets/js/app.js": { drop: true } };
    expect(await assetSmokeCheck(get, ASSETS)).toEqual({
      ok: false,
      problems: ["/assets/js/app.js: status 404"],
    });
  });

  test("a wrong content type is named", async () => {
    faults = { "/assets/hangar.css": { contentType: "text/plain" } };
    expect(await assetSmokeCheck(get, ASSETS)).toEqual({
      ok: false,
      problems: ["/assets/hangar.css: content-type text/plain, expected text/css; charset=utf-8"],
    });
  });

  test("a truncated body is named, counted in bytes rather than characters", async () => {
    // The body holds characters that take more than one byte in UTF-8, so its
    // byte length and its string length differ: the check counts bytes.
    faults = { "/assets/js/app.js": { truncate: true } };
    const body = ASSETS["/assets/js/app.js"]?.body ?? "";
    const expected = Buffer.byteLength(body);
    expect(expected).toBeGreaterThan(body.length);
    const served = Buffer.byteLength(body.slice(0, -2));
    expect(await assetSmokeCheck(get, ASSETS)).toEqual({
      ok: false,
      problems: [`/assets/js/app.js: ${served} bytes, expected ${expected}`],
    });
  });

  test("several faults are each named, with their key", async () => {
    faults = { "/": { drop: true }, "/assets/icon.svg": { contentType: "text/html" } };
    const result = await assetSmokeCheck(get, ASSETS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([
        "/: status 404",
        "/assets/icon.svg: content-type text/html, expected image/svg+xml",
      ]);
    }
  });

  test("a fetch that throws is a problem for that key, not a crash", async () => {
    faults = {};
    const failing = (path: string) =>
      path === "/" ? Promise.reject(new Error("connection refused")) : get(path);
    expect(await assetSmokeCheck(failing, ASSETS)).toEqual({
      ok: false,
      problems: ["/: connection refused"],
    });
  });

  test("an empty map proves nothing, so it fails", async () => {
    expect(await assetSmokeCheck(get, {})).toEqual({
      ok: false,
      problems: ["no embedded console files to check"],
    });
  });
});

test("problemSummary lists the first five and counts the rest", () => {
  const problems = Array.from({ length: 7 }, (_, i) => `p${i}`);
  expect(problemSummary(problems)).toBe("p0; p1; p2; p3; p4; and 2 more");
  expect(problemSummary(["only"])).toBe("only");
});
