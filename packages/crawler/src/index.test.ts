import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCitationTracker } from "@crewhaus/citation-tracker";
import { createCrawler } from "./index.js";

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "crawler-"));
}

describe("createCrawler — http transport", () => {
  test("denies an http origin not on the allow-list", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedOrigins: new Set([]) },
      });
      await expect(crawler.fetch("https://example.com/x")).rejects.toThrow(/allow-list/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns body and records on tracker on first fetch", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () =>
            new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
        },
      });
      const r = await crawler.fetch("https://example.com/x");
      expect(r.fromCache).toBe(false);
      expect(r.content).toBe("hello");
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(tracker.hasFetched("https://example.com/x")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("second call to the same URL is cache-served (T4 dedup invariant)", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      let calls = 0;
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => {
            calls += 1;
            return new Response("hello", { status: 200 });
          },
        },
      });
      await crawler.fetch("https://example.com/x");
      const second = await crawler.fetch("https://example.com/x");
      expect(calls).toBe(1);
      expect(second.fromCache).toBe(true);
      expect(second.content).toBe("hello");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("redirect handling: respects allow-list at every hop", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://a.example.com"]),
          _httpFetch: async () =>
            new Response("redir", {
              status: 302,
              headers: { location: "https://forbidden.example.com/y" },
            }),
        },
      });
      await expect(crawler.fetch("https://a.example.com/x")).rejects.toThrow(/redirect target/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — file:// transport", () => {
  test("reads file body when path is under an allowed root", async () => {
    const root = newRoot();
    const fixture = join(root, "fixture.txt");
    writeFileSync(fixture, "hello-from-disk");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: [root] },
      });
      const r = await crawler.fetch(`file://${fixture}`);
      expect(r.content).toBe("hello-from-disk");
      expect(r.fromCache).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects file paths outside the allowed roots", async () => {
    const root = newRoot();
    const fixture = join(root, "fixture.txt");
    writeFileSync(fixture, "hello");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: ["/nonexistent-root"] },
      });
      await expect(crawler.fetch(`file://${fixture}`)).rejects.toThrow(/outside the configured/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("file fetch is also dedup'd via the tracker", async () => {
    const root = newRoot();
    const fixture = join(root, "fixture.txt");
    writeFileSync(fixture, "v1");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: [root] },
      });
      const url = `file://${fixture}`;
      await crawler.fetch(url);
      // Mutate the file to prove cache is served, NOT disk:
      writeFileSync(fixture, "v2");
      const second = await crawler.fetch(url);
      expect(second.fromCache).toBe(true);
      expect(second.content).toBe("v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — unsupported schemes", () => {
  test("rejects ftp:// and other schemes", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({ tracker });
      await expect(crawler.fetch("ftp://example.com/x")).rejects.toThrow(/unsupported URL scheme/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
