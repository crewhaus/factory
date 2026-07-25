import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("recordFetch restores a pruned cache file when the body still matches the recorded sha256", () => {
    const root = newRoot();
    const runId = newRunId();
    try {
      const t1 = createCitationTracker({ runId, rootDir: root });
      const body = "alpha beta gamma";
      const rec = t1.recordFetch({ url: "u", content: body });

      // Content cache pruned (disk cleanup / a run dir copied without cache/),
      // fetches.jsonl kept. Without repair the body is unrecoverable, and any
      // consumer that verifies a citation snippet against it fails forever.
      rmSync(join(root, runId, "cache"), { recursive: true, force: true });
      const t2 = createCitationTracker({ runId, rootDir: root });
      expect(t2.getFetchedContent("u")).toBeUndefined();

      // A re-fetch of the same bytes puts the body back.
      expect(t2.recordFetch({ url: "u", content: body })).toEqual(rec);
      expect(t2.getFetchedContent("u")).toBe(body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordFetch does NOT re-cache a mutated body under the original sha256", () => {
    const root = newRoot();
    const runId = newRunId();
    try {
      const t1 = createCitationTracker({ runId, rootDir: root });
      t1.recordFetch({ url: "u", content: "original" });
      rmSync(join(root, runId, "cache"), { recursive: true, force: true });

      const t2 = createCitationTracker({ runId, rootDir: root });
      t2.recordFetch({ url: "u", content: "mutated since the first fetch" });
      // The record's sha256 describes "original"; caching other bytes under it
      // would make the digest a lie. Stay empty instead.
      expect(t2.getFetchedContent("u")).toBeUndefined();
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

  test("malformed jsonl in citations.jsonl surfaces as a CitationTrackerError", () => {
    const root = newRoot();
    const runId = newRunId();
    const path = join(root, runId, "citations.jsonl");
    try {
      const t = createCitationTracker({ runId, rootDir: root });
      t.recordCitation({ url: "u", snippet: "s" });
      appendFileSync(path, "{not valid json\n");
      expect(() => createCitationTracker({ runId, rootDir: root })).toThrow(CitationTrackerError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("getFetchRecord returns metadata for a known URL and undefined otherwise", () => {
    const root = newRoot();
    try {
      const t = createCitationTracker({ rootDir: root });
      expect(t.getFetchRecord("missing")).toBeUndefined();
      const rec = t.recordFetch({ url: "u", content: "the body", branchId: "b7" });
      const got = t.getFetchRecord("u");
      expect(got).toEqual(rec);
      expect(got?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(got?.contentBytes).toBe(Buffer.byteLength("the body", "utf8"));
      expect(got?.branchId).toBe("b7");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("getFetchedContent returns undefined for an unknown URL", () => {
    const root = newRoot();
    try {
      const t = createCitationTracker({ rootDir: root });
      expect(t.getFetchedContent("never-fetched")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listFetches returns all fetch records in append order", () => {
    const root = newRoot();
    try {
      const t = createCitationTracker({ rootDir: root });
      expect(t.listFetches()).toEqual([]);
      t.recordFetch({ url: "first", content: "1" });
      t.recordFetch({ url: "second", content: "2" });
      // Idempotent re-record must NOT add a second entry.
      t.recordFetch({ url: "first", content: "1-again" });
      const urls = t.listFetches().map((r) => r.url);
      expect(urls).toEqual(["first", "second"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listFetches survives kill-and-resume in append order", () => {
    const root = newRoot();
    const runId = newRunId();
    try {
      const t1 = createCitationTracker({ runId, rootDir: root });
      t1.recordFetch({ url: "a", content: "ka" });
      t1.recordFetch({ url: "b", content: "kb" });
      const t2 = createCitationTracker({ runId, rootDir: root });
      expect(t2.listFetches().map((r) => r.url)).toEqual(["a", "b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordCitation carries branchId and supportingClaim through to disk", () => {
    const root = newRoot();
    const runId = newRunId();
    try {
      const t = createCitationTracker({ runId, rootDir: root });
      const c = t.recordCitation({
        url: "u",
        snippet: "s",
        branchId: "branch-9",
        supportingClaim: "supports: target shapes list",
      });
      expect(c.branchId).toBe("branch-9");
      expect(c.supportingClaim).toBe("supports: target shapes list");

      // Round-trips verbatim through the JSONL on resume.
      const reopened = createCitationTracker({ runId, rootDir: root });
      const persisted = reopened.listCitationsOrdered()[0];
      expect(persisted?.branchId).toBe("branch-9");
      expect(persisted?.supportingClaim).toBe("supports: target shapes list");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("now() injection makes retrievedAt deterministic", () => {
    const root = newRoot();
    try {
      const fixed = new Date("2030-01-02T03:04:05.000Z");
      const t = createCitationTracker({ rootDir: root, now: () => fixed });
      const f = t.recordFetch({ url: "u", content: "x" });
      expect(f.retrievedAt).toBe("2030-01-02T03:04:05.000Z");
      // Citation with no prior fetch also stamps via now().
      const c = t.recordCitation({ url: "other", snippet: "s" });
      expect(c.retrievedAt).toBe("2030-01-02T03:04:05.000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("newRunId produces well-formed, accepted run ids", () => {
    const root = newRoot();
    try {
      const id = newRunId();
      expect(id).toMatch(/^run_[0-9a-f]{16}$/);
      // A freshly-minted id must be accepted by the validator.
      const t = createCitationTracker({ runId: id, rootDir: root });
      expect(t.runId).toBe(id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("security: a tampered sha256 in fetches.jsonl cannot traverse out of the cache dir", () => {
    const root = newRoot();
    const runId = newRunId();
    try {
      // Boot once to create the run dir, then overwrite fetches.jsonl with a
      // record whose sha256 is a path-traversal payload. A secret file lives
      // two levels up (the runId dir) at a guessable name.
      createCitationTracker({ runId, rootDir: root });
      const secretPath = join(root, runId, "stolen.txt");
      writeFileSync(secretPath, "TOP SECRET CONTENTS");
      // cache/<sha256>.txt -> cache/../stolen.txt resolves to the secret file.
      const evilRecord = {
        version: 1,
        url: "https://victim.example/x",
        retrievedAt: "2030-01-01T00:00:00.000Z",
        sha256: "../stolen",
        contentBytes: 19,
      };
      writeFileSync(join(root, runId, "fetches.jsonl"), `${JSON.stringify(evilRecord)}\n`);

      const t = createCitationTracker({ runId, rootDir: root });
      expect(t.hasFetched("https://victim.example/x")).toBe(true);
      // The guard must refuse the malformed sha256 rather than read the secret.
      expect(t.getFetchedContent("https://victim.example/x")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
