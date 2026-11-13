/**
 * Static assets revalidate: a browser keeps its copy and asks each time
 * whether it is current, so a new release's module is fetched the first time
 * it is asked for and an unchanged one costs a 304. The shell page is never
 * kept at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { HOME_CSP } from "./csp";
import type { StaticAsset } from "./server";
import { assetTag, noneMatchHits } from "./static-cache";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

const JS = "text/javascript; charset=utf-8";
const HTML = "text/html; charset=utf-8";

function boot(assets: Record<string, StaticAsset>): TestServer {
  const t = bootTestServer({ assets });
  servers.push(t);
  return t;
}

describe("an asset", () => {
  test("is served with a strong tag, no-cache, and the page policy", async () => {
    const t = boot({
      "/": { body: "<!doctype html>", contentType: HTML },
      "/assets/a.js": { body: "export const a = 1;", contentType: JS },
    });
    const res = await t.fetchRaw("/assets/a.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("export const a = 1;");
    const etag = res.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-security-policy")).toBe(HOME_CSP);
    expect(res.headers.get("content-type")).toBe(JS);
  });

  test("a matching If-None-Match is a 304 with no body and the same headers", async () => {
    const t = boot({ "/assets/a.js": { body: "export const a = 1;", contentType: JS } });
    const first = await t.fetchRaw("/assets/a.js");
    const etag = first.headers.get("etag") ?? "";
    const again = await t.fetchRaw("/assets/a.js", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("no-cache");
    expect(again.headers.get("content-security-policy")).toBe(HOME_CSP);
  });

  test("a weak form of the tag, a list holding it, and * all match", async () => {
    const t = boot({ "/assets/a.js": { body: "export const a = 1;", contentType: JS } });
    const etag = (await t.fetchRaw("/assets/a.js")).headers.get("etag") ?? "";
    for (const header of [`W/${etag}`, `"nope", ${etag}`, `"x",W/${etag} , "y"`, "*"]) {
      const res = await t.fetchRaw("/assets/a.js", { headers: { "if-none-match": header } });
      expect(`${header} → ${res.status}`).toBe(`${header} → 304`);
    }
  });

  test("a tag for other bytes is a 200 with the full body", async () => {
    const t = boot({ "/assets/a.js": { body: "export const a = 2;", contentType: JS } });
    const stale = assetTag({ body: "export const a = 1;", contentType: JS });
    const res = await t.fetchRaw("/assets/a.js", { headers: { "if-none-match": stale } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("export const a = 2;");
    expect(res.headers.get("etag")).not.toBe(stale);
  });

  test("without If-None-Match it is a 200 with the full body, every time", async () => {
    const t = boot({ "/assets/a.js": { body: "export const a = 1;", contentType: JS } });
    for (let i = 0; i < 2; i += 1) {
      const res = await t.fetchRaw("/assets/a.js");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("export const a = 1;");
    }
  });
});

describe("the shell", () => {
  test("/ is never kept: no-store and no tag, even when asked to revalidate", async () => {
    const t = boot({ "/": { body: "<!doctype html>", contentType: HTML } });
    const res = await t.fetchRaw("/", { headers: { "if-none-match": "*" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe(HOME_CSP);
  });

  test("decided by the asset served for /, wherever the map keys it", async () => {
    const shell: StaticAsset = { body: "<!doctype html><title>x</title>", contentType: HTML };
    const t = boot({ "/index.html": shell });
    for (const path of ["/", "/index.html"]) {
      const res = await t.fetchRaw(path);
      expect(`${path} ${res.status} ${res.headers.get("cache-control")}`).toBe(
        `${path} 200 no-store`,
      );
      expect(res.headers.get("etag")).toBeNull();
    }
  });
});

describe("the shell, by the asset rather than by its path", () => {
  test("another address serving the asset served for / is never kept either", async () => {
    const shell: StaticAsset = { body: "shell", contentType: "text/plain; charset=utf-8" };
    const t = boot({ "/": shell, "/invite": shell, "/assets/x.txt": { ...shell } });
    await t.fetchRaw("/");
    const res = await t.fetchRaw("/invite");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
    // The same bytes in a different asset object are an ordinary asset.
    const other = await t.fetchRaw("/assets/x.txt");
    expect(other.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("the pure parts", () => {
  test("the tag is a hash of the body, memoized per asset object", () => {
    const a: StaticAsset = { body: "x", contentType: JS };
    expect(assetTag(a)).toBe(assetTag(a));
    expect(assetTag(a)).toBe(assetTag({ body: "x", contentType: JS }));
    expect(assetTag(a)).not.toBe(assetTag({ body: "y", contentType: JS }));
    // Bytes and the same text tag alike.
    expect(assetTag({ body: new TextEncoder().encode("x"), contentType: JS })).toBe(assetTag(a));
  });

  test("If-None-Match parsing", () => {
    expect(noneMatchHits(null, '"a"')).toBe(false);
    expect(noneMatchHits("", '"a"')).toBe(false);
    expect(noneMatchHits('"b"', '"a"')).toBe(false);
    expect(noneMatchHits('"a"', '"a"')).toBe(true);
    expect(noneMatchHits('W/"a"', '"a"')).toBe(true);
    expect(noneMatchHits(' "b" , "a" ', '"a"')).toBe(true);
    expect(noneMatchHits("*", '"a"')).toBe(true);
  });
});
