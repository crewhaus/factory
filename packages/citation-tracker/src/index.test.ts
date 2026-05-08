import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CitationTrackerError, createCitationTracker, newRunId } from "./index.js";

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "citation-tracker-"));
}

describe("createCitationTracker", () => {
  test("hasFetched returns false for fresh tracker, true after recordFetch", () => {
    const root = newRoot();
    try {
      const t = createCitationTracker({ rootDir: root });
      expect(t.hasFetched("https://example.com/a")).toBe(false);
      t.recordFetch({ url: "https://example.com/a", content: "hello world" });
      expect(t.hasFetched("https://example.com/a")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordFetch is idempotent — re-recording same URL returns first record", () => {
    const root = newRoot();
    try {
      const t = createCitationTracker({ rootDir: root });
      const first = t.recordFetch({ url: "u", content: "v1" });
      const second = t.recordFetch({ url: "u", content: "v2-different" });
      // First write wins; the second record is the same as the first.
      expect(second).toEqual(first);
      expect(t.getFetchedContent("u")).toBe("v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("getFetchedContent returns the original body verbatim (T4 cache hit)", () => {
    const root = newRoot();
    try {
      const t = createCitationTracker({ rootDir: root });
      const body = "some\nmulti\nline\ncontent";
      t.recordFetch({ url: "u", content: body });
      expect(t.getFetchedContent("u")).toBe(body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("kill-and-resume: a new tracker against the same runId/rootDir picks up prior fetches (T4)", () => {
    const root = newRoot();
    const runId = newRunId();
    try {
      const t1 = createCitationTracker({ runId, rootDir: root });
      t1.recordFetch({ url: "u1", content: "body-1" });
      t1.recordCitation({ url: "u1", snippet: "snippet-1", branchId: "b1" });

      // Simulate kill by dropping t1; new tracker reads files back.
      const t2 = createCitationTracker({ runId, rootDir: root });
      expect(t2.hasFetched("u1")).toBe(true);
      expect(t2.getFetchedContent("u1")).toBe("body-1");
      const cs = t2.listCitationsOrdered();
      expect(cs).toHaveLength(1);
      expect(cs[0]?.url).toBe("u1");
      expect(cs[0]?.snippet).toBe("snippet-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listCitationsOrdered returns citations in append order — deterministic across re-runs", () => {
    const root = newRoot();
    const runId = newRunId();
    try {
      const t = createCitationTracker({ runId, rootDir: root });
      t.recordFetch({ url: "a", content: "ka" });
      t.recordFetch({ url: "b", content: "kb" });
      t.recordCitation({ url: "a", snippet: "fact a-1" });
      t.recordCitation({ url: "b", snippet: "fact b-1" });
      t.recordCitation({ url: "a", snippet: "fact a-2" });

      const reopened = createCitationTracker({ runId, rootDir: root });
      const order = reopened.listCitationsOrdered().map((c) => c.snippet);
      expect(order).toEqual(["fact a-1", "fact b-1", "fact a-2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordCitation pulls sha256 from the matching fetch record when present", () => {
    const root = newRoot();
    try {
      const t = createCitationTracker({ rootDir: root });
      const f = t.recordFetch({ url: "u", content: "the body text" });
      const c = t.recordCitation({ url: "u", snippet: "body" });
      expect(c.sha256).toBe(f.sha256);
      expect(c.retrievedAt).toBe(f.retrievedAt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordCitation with no prior fetch hashes the snippet itself", () => {
    const root = newRoot();
    try {
      const t = createCitationTracker({ rootDir: root });
      const c = t.recordCitation({ url: "u", snippet: "abc" });
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid runId throws", () => {
    const root = newRoot();
    try {
      expect(() => createCitationTracker({ runId: "bad", rootDir: root })).toThrow(/invalid runId/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed jsonl on disk surfaces as a CitationTrackerError", async () => {
    const root = newRoot();
    const runId = newRunId();
    const path = join(root, runId, "fetches.jsonl");
    try {
      // Create the dir + a malformed file.
      const t = createCitationTracker({ runId, rootDir: root });
      t.recordFetch({ url: "u", content: "ok" });
      // Append garbage and re-open.
      const fs = await import("node:fs");
      fs.appendFileSync(path, "not-json\n");
      expect(() => createCitationTracker({ runId, rootDir: root })).toThrow(CitationTrackerError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
