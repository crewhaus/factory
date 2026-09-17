/**
 * The tools against a real filesystem.
 *
 * Every test builds a throwaway directory under the OS temp dir, chdir's into
 * it (the workspace root is `process.cwd()`, as in `@crewhaus/tool-fs`) and
 * removes it afterwards. Nothing is ever written inside the repository and no
 * filesystem call is mocked: a mocked `rename` would prove nothing about
 * whether a concurrent writer can clobber a counter, which is most of what
 * these tools have to get right.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  STATE_TOOLS,
  blackboardPost,
  blackboardRead,
  checkpointList,
  checkpointLoad,
  checkpointSave,
  counterGet,
  counterIncrement,
  dedupeMark,
  indexBuild,
  indexSearch,
  journalAppend,
  journalRead,
  kvDelete,
  kvGet,
  kvList,
  kvSet,
  noteSearch,
  noteWrite,
  stateExport,
  stateImport,
} from "./index";

const originalCwd = process.cwd();
let tmp: string;
/** Directories created outside the workspace by containment tests. */
let outsiders: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-state-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  for (const dir of outsiders) rmSync(dir, { recursive: true, force: true });
  outsiders = [];
});

function outside(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crewhaus-state-outside-"));
  outsiders.push(dir);
  return dir;
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: RegisteredTool, input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** The on-disk path of a state file, for the tests that corrupt one on purpose. */
function statePath(...segments: string[]): string {
  return path.join(tmp, ".crewhaus/state", ...segments);
}

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-01T00:00:30Z";
const T2 = "2026-01-01T01:00:00Z";

// ---------------------------------------------------------------------------

describe("tool definitions", () => {
  test("there are twenty, each registered once", () => {
    expect(STATE_TOOLS.length).toBe(20);
    expect(new Set(STATE_TOOLS.map((tool) => tool.name)).size).toBe(20);
  });

  test("every name is PascalCase", () => {
    for (const tool of STATE_TOOLS) expect(tool.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every description's second sentence tells the model when to use it", () => {
    for (const tool of STATE_TOOLS) {
      const sentences = tool.description.split(". ");
      expect({ name: tool.name, second: sentences[1]?.slice(0, 4) }).toEqual({
        name: tool.name,
        second: "Use ",
      });
    }
  });

  test("nothing here crosses a process or network boundary", () => {
    expect(auditToolScopes(STATE_TOOLS)).toEqual([]);
    for (const tool of STATE_TOOLS) {
      expect({ name: tool.name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        name: tool.name,
        scope: "internal",
        io: undefined,
      });
    }
  });

  test("a tool is either a pure read or a writer, never labelled as both", () => {
    for (const tool of STATE_TOOLS) {
      expect({ name: tool.name, both: tool.readOnly && tool.destructive }).toEqual({
        name: tool.name,
        both: false,
      });
      expect({ name: tool.name, labelled: tool.readOnly || tool.destructive }).toEqual({
        name: tool.name,
        labelled: true,
      });
    }
  });

  test("the writers are exactly the ones that change the state directory", () => {
    const writers = STATE_TOOLS.filter((tool) => tool.destructive)
      .map((tool) => tool.name)
      .sort();
    expect(writers).toEqual([
      "BlackboardPost",
      "CheckpointSave",
      "CounterIncrement",
      "DedupeMark",
      "IndexBuild",
      "JournalAppend",
      "KvDelete",
      "KvSet",
      "NoteWrite",
      "StateImport",
    ]);
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const tool of STATE_TOOLS) {
      expect({ name: tool.name, ok: tool.inputSchema.safeParse(42).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("path containment", () => {
  test("a state directory outside the workspace is refused", async () => {
    const out = await run(kvSet, { namespace: "n", key: "k", value: 1, stateDir: "../escape" });
    expect(out).toContain("escapes the workspace root");
  });

  test("an absolute state directory outside the workspace is refused", async () => {
    const out = await run(kvGet, { namespace: "n", key: "k", stateDir: outside() });
    expect(out).toContain("escapes the workspace root");
  });

  test("a symlink inside the workspace pointing out of it is refused", async () => {
    symlinkSync(outside(), path.join(tmp, "link"));
    const out = await run(journalAppend, { stream: "s", entry: {}, stateDir: "link/state" });
    expect(out).toContain("escapes the workspace root");
  });

  test("a key full of traversal is stored as a file, not as a path", async () => {
    await run(kvSet, { namespace: "n", key: "../../etc/passwd", value: "safe" });
    const files = readdirSync(statePath("kv", "n"));
    expect(files.some((name) => name.includes("/"))).toBe(false);
    const got = await run(kvGet, { namespace: "n", key: "../../etc/passwd" });
    expect(got.value).toBe("safe");
  });

  test("a namespace with a separator is refused before it reaches the filesystem", async () => {
    expect(await run(kvSet, { namespace: "a/b", key: "k", value: 1 })).toContain("namespace");
    expect(await run(journalAppend, { stream: "..", entry: {} })).toContain("stream");
  });

  // CWE-59. The state directory is checked on the way in, but a path INSIDE
  // it can be a symlink too — and then a textually-contained write lands
  // wherever the link points. These are the ones that actually escape.
  test("a symlinked directory inside the state directory is refused, not written through", async () => {
    const target = outside();
    mkdirSync(statePath("kv"), { recursive: true });
    symlinkSync(target, statePath("kv", "escape"));
    const out = await run(kvSet, { namespace: "escape", key: "pwn", value: 1 });
    expect(out).toContain("escapes the workspace root");
    expect(readdirSync(target)).toEqual([]);
  });

  test("a DANGLING symlink is refused rather than created through", async () => {
    const target = path.join(outside(), "not-there-yet");
    mkdirSync(statePath("journal"), { recursive: true });
    symlinkSync(target, statePath("journal", "s.jsonl"));
    const out = await run(journalAppend, { stream: "s", entry: { a: 1 } });
    expect(out).toContain("escapes the workspace root");
    expect(existsSync(target)).toBe(false);
  });

  test("StateImport will not write through a symlink inside the state directory", async () => {
    const target = outside();
    mkdirSync(statePath(), { recursive: true });
    symlinkSync(target, statePath("linked"));
    const out = await run(stateImport, {
      document: {
        version: 1,
        files: [{ path: "linked/pwn.txt", encoding: "utf8", content: "owned" }],
      },
    });
    expect(out.written).toBe(0);
    expect(out.refused[0]).toMatchObject({ path: "linked/pwn.txt" });
    expect(readdirSync(target)).toEqual([]);
  });

  test("an index is never built over a file outside the workspace", async () => {
    const target = outside();
    writeFileSync(path.join(target, "secret.txt"), "alpha secret");
    symlinkSync(target, path.join(tmp, "link"));
    const out = await run(indexBuild, { name: "i", paths: ["link/secret.txt"] });
    expect(out.documents).toBe(0);
    expect(out.skipped[0]).toMatchObject({ reason: "resolves outside the workspace" });
  });
});

// ---------------------------------------------------------------------------

describe("KvSet / KvGet / KvDelete / KvList", () => {
  test("stores and reads a value back, versioning each write", async () => {
    const first = await run(kvSet, { namespace: "orders", key: "o-1", value: { total: 3 } });
    expect(first).toMatchObject({ stored: true, version: 1, created: true });
    const second = await run(kvSet, { namespace: "orders", key: "o-1", value: { total: 4 } });
    expect(second).toMatchObject({ stored: true, version: 2, created: false });
    const got = await run(kvGet, { namespace: "orders", key: "o-1" });
    expect(got).toMatchObject({ found: true, value: { total: 4 }, version: 2 });
  });

  test("a missing key is a result, not an error", async () => {
    expect(await run(kvGet, { namespace: "orders", key: "nope" })).toEqual({
      found: false,
      namespace: "orders",
      key: "nope",
    });
  });

  test("keys survive slashes, spaces, unicode and case", async () => {
    for (const key of ["a/b", "hello world", "héllo", "Key", "key", "https://x.test/?a=1"]) {
      await run(kvSet, { namespace: "n", key, value: key });
    }
    for (const key of ["a/b", "hello world", "héllo", "Key", "key", "https://x.test/?a=1"]) {
      expect((await run(kvGet, { namespace: "n", key })).value).toBe(key);
    }
  });

  test("two keys differing only in case do not share a file", async () => {
    await run(kvSet, { namespace: "n", key: "Key", value: "upper" });
    await run(kvSet, { namespace: "n", key: "key", value: "lower" });
    expect((await run(kvGet, { namespace: "n", key: "Key" })).value).toBe("upper");
    expect((await run(kvGet, { namespace: "n", key: "key" })).value).toBe("lower");
  });

  test("a value the caller forgot is refused rather than stored as null", async () => {
    expect(await run(kvSet, { namespace: "n", key: "k" })).toContain("value is required");
  });

  describe("compare-and-set", () => {
    test("refuses a write against a stale version and reports the current one", async () => {
      await run(kvSet, { namespace: "n", key: "k", value: 1 });
      await run(kvSet, { namespace: "n", key: "k", value: 2 });
      const out = await run(kvSet, { namespace: "n", key: "k", value: 3, expectedVersion: 1 });
      expect(out).toMatchObject({ stored: false, conflict: true, currentVersion: 2 });
      expect((await run(kvGet, { namespace: "n", key: "k" })).value).toBe(2);
    });

    test("accepts a write against the current version", async () => {
      await run(kvSet, { namespace: "n", key: "k", value: 1 });
      const out = await run(kvSet, { namespace: "n", key: "k", value: 2, expectedVersion: 1 });
      expect(out).toMatchObject({ stored: true, version: 2 });
    });

    test("version 0 claims a key only if nobody else has", async () => {
      const first = await run(kvSet, {
        namespace: "n",
        key: "claim",
        value: "a",
        expectedVersion: 0,
      });
      expect(first.stored).toBe(true);
      const second = await run(kvSet, {
        namespace: "n",
        key: "claim",
        value: "b",
        expectedVersion: 0,
      });
      expect(second).toMatchObject({ stored: false, conflict: true });
    });

    test("two agents racing for the same key: exactly one wins", async () => {
      const attempts = await Promise.all(
        ["a", "b", "c", "d"].map((who) =>
          run(kvSet, { namespace: "n", key: "lock", value: who, expectedVersion: 0 }),
        ),
      );
      expect(attempts.filter((out) => out.stored === true).length).toBe(1);
    });

    test("delete honours a version check", async () => {
      await run(kvSet, { namespace: "n", key: "k", value: 1 });
      expect(await run(kvDelete, { namespace: "n", key: "k", expectedVersion: 9 })).toMatchObject({
        deleted: false,
        conflict: true,
      });
      expect(await run(kvDelete, { namespace: "n", key: "k", expectedVersion: 1 })).toMatchObject({
        deleted: true,
      });
      expect(await run(kvDelete, { namespace: "n", key: "k" })).toEqual({
        deleted: false,
        existed: false,
      });
    });
  });

  describe("expiry", () => {
    test("is computed from the caller's instant, and TTL without one is refused", async () => {
      expect(await run(kvSet, { namespace: "n", key: "k", value: 1, ttlSeconds: 60 })).toContain(
        "ttlSeconds needs `now`",
      );
      const stored = await run(kvSet, {
        namespace: "n",
        key: "k",
        value: 1,
        ttlSeconds: 60,
        now: T0,
      });
      expect(stored.expiresAt).toBe("2026-01-01T00:01:00.000Z");
    });

    test("a record reads back before its expiry and is gone after it", async () => {
      await run(kvSet, { namespace: "n", key: "k", value: 1, ttlSeconds: 60, now: T0 });
      expect(await run(kvGet, { namespace: "n", key: "k", now: T1 })).toMatchObject({
        found: true,
      });
      expect(await run(kvGet, { namespace: "n", key: "k", now: T2 })).toMatchObject({
        found: false,
        expired: true,
      });
    });

    test("without `now` the expiry is not evaluated, and the result says so", async () => {
      await run(kvSet, { namespace: "n", key: "k", value: 1, ttlSeconds: 60, now: T0 });
      const got = await run(kvGet, { namespace: "n", key: "k" });
      expect(got).toMatchObject({ found: true, expired: false, expiryChecked: false });
    });

    test("includeExpired returns the value anyway", async () => {
      await run(kvSet, { namespace: "n", key: "k", value: 1, ttlSeconds: 60, now: T0 });
      const got = await run(kvGet, { namespace: "n", key: "k", now: T2, includeExpired: true });
      expect(got).toMatchObject({ found: true, expired: true, value: 1 });
    });

    test("an unreadable `now` is a readable complaint", async () => {
      expect(await run(kvGet, { namespace: "n", key: "k", now: "yesterday" })).toContain(
        "not an ISO-8601 instant",
      );
    });
  });

  describe("KvList", () => {
    beforeEach(async () => {
      for (const key of ["b", "a", "c"]) {
        await run(kvSet, { namespace: "n", key, value: key.toUpperCase() });
      }
      await run(kvSet, { namespace: "n", key: "gone", value: 1, ttlSeconds: 10, now: T0 });
    });

    test("is sorted, and values are opt-in", async () => {
      const out = await run(kvList, { namespace: "n" });
      expect(out.keys.map((k: { key: string }) => k.key)).toEqual(["a", "b", "c", "gone"]);
      expect(out.keys[0].value).toBeUndefined();
      const withValues = await run(kvList, { namespace: "n", includeValues: true });
      expect(withValues.keys[0].value).toBe("A");
    });

    test("filters on prefix and hides expired records when given a now", async () => {
      expect((await run(kvList, { namespace: "n", prefix: "g" })).total).toBe(1);
      const later = await run(kvList, { namespace: "n", now: T2 });
      expect(later.total).toBe(3);
      expect(later.expiredSkipped).toBe(1);
    });

    test("an empty namespace lists nothing rather than failing", async () => {
      expect(await run(kvList, { namespace: "empty" })).toMatchObject({ total: 0, keys: [] });
    });

    test("the same call twice returns the same bytes", async () => {
      const a = await kvList.execute({ namespace: "n", includeValues: true });
      const b = await kvList.execute({ namespace: "n", includeValues: true });
      expect(a).toBe(b);
    });
  });

  describe("corruption", () => {
    test("a half-written record is reported, with the path and the reason", async () => {
      await run(kvSet, { namespace: "n", key: "k", value: 1 });
      writeFileSync(statePath("kv", "n", "k.json"), '{"key":"k","val');
      const out = await run(kvGet, { namespace: "n", key: "k" });
      expect(out).toContain("kv/n/k.json");
      expect(out).toContain("not valid JSON");
    });

    test("a record that is JSON but not a record is reported too", async () => {
      mkdirSync(statePath("kv", "n"), { recursive: true });
      writeFileSync(statePath("kv", "n", "k.json"), '{"hello":"world"}');
      expect(await run(kvGet, { namespace: "n", key: "k" })).toContain("not a state record");
    });

    test("one corrupt record does not stop a listing", async () => {
      await run(kvSet, { namespace: "n", key: "good", value: 1 });
      await run(kvSet, { namespace: "n", key: "bad", value: 1 });
      writeFileSync(statePath("kv", "n", "bad.json"), "{{{");
      const out = await run(kvList, { namespace: "n" });
      expect(out.keys.map((k: { key: string }) => k.key)).toEqual(["good"]);
      expect(out.corrupt[0].file).toBe("bad.json");
    });

    test("a corrupt record can still be deleted", async () => {
      await run(kvSet, { namespace: "n", key: "k", value: 1 });
      writeFileSync(statePath("kv", "n", "k.json"), "{{{");
      expect(await run(kvDelete, { namespace: "n", key: "k" })).toMatchObject({
        deleted: true,
        corrupt: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------

describe("CounterIncrement / CounterGet", () => {
  test("counts up from nothing and reads back", async () => {
    expect(await run(counterIncrement, { name: "hits" })).toMatchObject({ value: 1, previous: 0 });
    expect(await run(counterIncrement, { name: "hits", by: 4 })).toMatchObject({ value: 5 });
    expect(await run(counterGet, { name: "hits" })).toMatchObject({ value: 5, exists: true });
  });

  test("an untouched counter reads as 0 rather than as missing", async () => {
    expect(await run(counterGet, { name: "fresh" })).toEqual({
      name: "fresh",
      value: 0,
      exists: false,
      version: 0,
    });
  });

  test("goes down as well as up", async () => {
    await run(counterIncrement, { name: "budget", by: 10 });
    expect(await run(counterIncrement, { name: "budget", by: -3 })).toMatchObject({ value: 7 });
  });

  test("a limit refuses the increment and leaves the counter alone", async () => {
    await run(counterIncrement, { name: "quota", by: 5 });
    const out = await run(counterIncrement, { name: "quota", by: 1, limit: 5 });
    expect(out).toMatchObject({ applied: false, limited: true, value: 5 });
    expect((await run(counterGet, { name: "quota" })).value).toBe(5);
  });

  test("twenty concurrent increments all count", async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => run(counterIncrement, { name: "race", by: 1 })),
    );
    expect((await run(counterGet, { name: "race" })).value).toBe(20);
  });

  test("listing every counter is sorted and prefix-filterable", async () => {
    await run(counterIncrement, { name: "b.two" });
    await run(counterIncrement, { name: "a.one" });
    await run(counterIncrement, { name: "b.one" });
    const all = await run(counterGet, {});
    expect(all.counters.map((c: { name: string }) => c.name)).toEqual(["a.one", "b.one", "b.two"]);
    expect((await run(counterGet, { prefix: "b." })).count).toBe(2);
  });

  test("a corrupt counter is reported, not thrown", async () => {
    await run(counterIncrement, { name: "hits" });
    writeFileSync(statePath("counters", "hits.json"), "not json");
    expect(await run(counterGet, { name: "hits" })).toContain("counters/hits.json");
    expect(await run(counterIncrement, { name: "hits" })).toContain("is unusable");
  });

  test("no timestamp is stored unless the caller supplies one", async () => {
    await run(counterIncrement, { name: "hits" });
    expect(readFileSync(statePath("counters", "hits.json"), "utf8")).not.toContain("updatedAt");
    await run(counterIncrement, { name: "hits", now: T0 });
    expect(readFileSync(statePath("counters", "hits.json"), "utf8")).toContain(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------

describe("CheckpointSave / CheckpointLoad / CheckpointList", () => {
  test("saves numbered versions and loads the newest by default", async () => {
    expect(await run(checkpointSave, { name: "crawl", data: { page: 1 } })).toMatchObject({
      saved: true,
      version: 1,
    });
    await run(checkpointSave, { name: "crawl", data: { page: 2 }, label: "second" });
    const loaded = await run(checkpointLoad, { name: "crawl" });
    expect(loaded).toMatchObject({ found: true, version: 2, data: { page: 2 }, label: "second" });
  });

  test("an earlier version can be loaded by number", async () => {
    await run(checkpointSave, { name: "crawl", data: { page: 1 } });
    await run(checkpointSave, { name: "crawl", data: { page: 2 } });
    expect(await run(checkpointLoad, { name: "crawl", version: 1 })).toMatchObject({
      data: { page: 1 },
      latestVersion: 2,
    });
  });

  test("loading what was never saved reports it rather than failing", async () => {
    expect(await run(checkpointLoad, { name: "nope" })).toEqual({
      found: false,
      name: "nope",
      versions: 0,
    });
    await run(checkpointSave, { name: "crawl", data: 1 });
    expect(await run(checkpointLoad, { name: "crawl", version: 7 })).toMatchObject({
      found: false,
      availableVersions: [1],
    });
  });

  test("expectedVersion refuses a save on top of somebody else's", async () => {
    await run(checkpointSave, { name: "crawl", data: 1 });
    await run(checkpointSave, { name: "crawl", data: 2 });
    expect(await run(checkpointSave, { name: "crawl", data: 3, expectedVersion: 1 })).toMatchObject(
      {
        saved: false,
        conflict: true,
        latestVersion: 2,
      },
    );
    expect(await run(checkpointSave, { name: "crawl", data: 3, expectedVersion: 0 })).toMatchObject(
      {
        saved: false,
      },
    );
  });

  test("keep prunes the oldest versions", async () => {
    for (const page of [1, 2, 3, 4]) {
      await run(checkpointSave, { name: "crawl", data: { page }, keep: 2 });
    }
    const list = await run(checkpointList, { name: "crawl" });
    expect(list.checkpoints[0]).toMatchObject({ versions: 2, latestVersion: 4, oldestVersion: 3 });
    expect(await run(checkpointLoad, { name: "crawl", version: 1 })).toMatchObject({
      found: false,
    });
  });

  test("listing is sorted and carries the newest label", async () => {
    await run(checkpointSave, { name: "zeta", data: 1 });
    await run(checkpointSave, { name: "alpha", data: 1, label: "start", now: T0 });
    const list = await run(checkpointList, {});
    expect(list.checkpoints.map((c: { name: string }) => c.name)).toEqual(["alpha", "zeta"]);
    expect(list.checkpoints[0]).toMatchObject({
      label: "start",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("a corrupt checkpoint is reported with its path", async () => {
    await run(checkpointSave, { name: "crawl", data: 1 });
    writeFileSync(statePath("checkpoints", "crawl", "v0000001.json"), "oops");
    expect(await run(checkpointLoad, { name: "crawl" })).toContain(
      "checkpoints/crawl/v0000001.json",
    );
  });

  test("concurrent saves take distinct version numbers", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => run(checkpointSave, { name: "race", data: i })),
    );
    const versions = results.map((out) => out.version).sort((a: number, b: number) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------

describe("JournalAppend / JournalRead", () => {
  test("appends with a monotonic sequence and reads back in order", async () => {
    expect(await run(journalAppend, { stream: "runs", entry: { step: "a" } })).toMatchObject({
      seq: 1,
    });
    expect(await run(journalAppend, { stream: "runs", entry: { step: "b" } })).toMatchObject({
      seq: 2,
    });
    const out = await run(journalRead, { stream: "runs" });
    expect(out.entries.map((e: { data: { step: string } }) => e.data.step)).toEqual(["a", "b"]);
    expect(out.lastSeq).toBe(2);
  });

  test("sinceSeq gives a resuming reader only what is new", async () => {
    for (const step of ["a", "b", "c"])
      await run(journalAppend, { stream: "runs", entry: { step } });
    const out = await run(journalRead, { stream: "runs", sinceSeq: 2 });
    expect(out.entries.map((e: { seq: number }) => e.seq)).toEqual([3]);
  });

  test("filters on kind and substring, and can read the newest first", async () => {
    await run(journalAppend, { stream: "runs", entry: { m: "ok" }, kind: "info" });
    await run(journalAppend, { stream: "runs", entry: { m: "boom" }, kind: "error" });
    expect((await run(journalRead, { stream: "runs", kind: "error" })).matched).toBe(1);
    expect((await run(journalRead, { stream: "runs", contains: "boom" })).matched).toBe(1);
    const desc = await run(journalRead, { stream: "runs", order: "desc", limit: 1 });
    expect(desc.entries[0].seq).toBe(2);
    expect(desc.truncated).toBe(true);
  });

  test("reading a stream that does not exist yet is empty, not an error", async () => {
    expect(await run(journalRead, { stream: "never" })).toMatchObject({ total: 0, entries: [] });
  });

  test("a truncated last line is reported and the rest is still returned", async () => {
    await run(journalAppend, { stream: "runs", entry: { step: "a" } });
    await run(journalAppend, { stream: "runs", entry: { step: "b" } });
    appendFileSync(statePath("journal", "runs.jsonl"), '{"seq":3,"data":{"step":"c"');
    const out = await run(journalRead, { stream: "runs" });
    expect(out.total).toBe(2);
    expect(out.corruptLines[0]).toMatchObject({ line: 3 });
    expect(out.corruptLines[0].reason).toContain("truncated");
  });

  test("a lost sequence hint is rebuilt from the log itself, without reusing a number", async () => {
    await run(journalAppend, { stream: "runs", entry: { step: "a" } });
    await run(journalAppend, { stream: "runs", entry: { step: "b" } });
    rmSync(statePath("journal", "runs.jsonl.seq"));
    const out = await run(journalAppend, { stream: "runs", entry: { step: "c" } });
    expect(out).toMatchObject({ seq: 3, rebuiltSequence: true });
  });

  test("a corrupt sequence hint is rebuilt rather than trusted", async () => {
    await run(journalAppend, { stream: "runs", entry: { step: "a" } });
    writeFileSync(statePath("journal", "runs.jsonl.seq"), "garbage");
    expect(await run(journalAppend, { stream: "runs", entry: { step: "b" } })).toMatchObject({
      seq: 2,
    });
  });

  test("twenty concurrent appends get twenty distinct sequences and twenty whole lines", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => run(journalAppend, { stream: "race", entry: { i } })),
    );
    const seqs = results.map((out) => out.seq).sort((a: number, b: number) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const read = await run(journalRead, { stream: "race", limit: 100 });
    expect(read.total).toBe(20);
    expect(read.corruptLines).toBeUndefined();
  });

  test("listing the streams reports each one's last sequence", async () => {
    await run(journalAppend, { stream: "zeta", entry: {} });
    await run(journalAppend, { stream: "alpha", entry: {} });
    await run(journalAppend, { stream: "alpha", entry: {} });
    const out = await run(journalRead, {});
    expect(out.streams).toEqual([
      { name: "alpha", lastSeq: 2, bytes: expect.any(Number) },
      { name: "zeta", lastSeq: 1, bytes: expect.any(Number) },
    ]);
  });

  test("an entry carries no timestamp unless one was supplied", async () => {
    await run(journalAppend, { stream: "runs", entry: { step: "a" } });
    await run(journalAppend, { stream: "runs", entry: { step: "b" }, now: T0 });
    const out = await run(journalRead, { stream: "runs" });
    expect(out.entries[0].at).toBeUndefined();
    expect(out.entries[1].at).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------

describe("BlackboardPost / BlackboardRead", () => {
  test("crew members leave notes another can read", async () => {
    await run(blackboardPost, { topic: "incident", author: "scout", text: "db is hot" });
    await run(blackboardPost, { topic: "incident", author: "fixer", text: "rolling back" });
    const out = await run(blackboardRead, { topic: "incident" });
    expect(out.posts.map((p: { author: string }) => p.author)).toEqual(["scout", "fixer"]);
    expect(out.authors).toEqual(["fixer", "scout"]);
  });

  test("filters by author, tag and sequence", async () => {
    await run(blackboardPost, { topic: "t", author: "a", text: "one", tags: ["db", "urgent"] });
    await run(blackboardPost, { topic: "t", author: "b", text: "two", tags: ["db"] });
    expect((await run(blackboardRead, { topic: "t", author: "a" })).matched).toBe(1);
    expect((await run(blackboardRead, { topic: "t", tag: "urgent" })).matched).toBe(1);
    expect((await run(blackboardRead, { topic: "t", sinceSeq: 1 })).matched).toBe(1);
  });

  test("latestPerAuthor keeps each crew member's last word", async () => {
    await run(blackboardPost, { topic: "t", author: "a", text: "first" });
    await run(blackboardPost, { topic: "t", author: "b", text: "hello" });
    await run(blackboardPost, { topic: "t", author: "a", text: "second" });
    const out = await run(blackboardRead, { topic: "t", latestPerAuthor: true });
    expect(out.posts.map((p: { text: string }) => p.text)).toEqual(["hello", "second"]);
  });

  test("tags are stored sorted, so the same post is the same bytes", async () => {
    await run(blackboardPost, { topic: "t", author: "a", text: "x", tags: ["z", "a"] });
    expect((await run(blackboardRead, { topic: "t" })).posts[0].tags).toEqual(["a", "z"]);
  });

  test("listing the topics needs no topic", async () => {
    await run(blackboardPost, { topic: "beta", author: "a", text: "x" });
    await run(blackboardPost, { topic: "alpha", author: "a", text: "x" });
    const out = await run(blackboardRead, {});
    expect(out.topics.map((t: { topic: string }) => t.topic)).toEqual(["alpha", "beta"]);
  });

  test("a corrupt line is reported and the others still come back", async () => {
    await run(blackboardPost, { topic: "t", author: "a", text: "good" });
    appendFileSync(statePath("blackboard", "t.jsonl"), "not json\n");
    const out = await run(blackboardRead, { topic: "t" });
    expect(out.total).toBe(1);
    expect(out.corruptLines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("NoteWrite / NoteSearch", () => {
  beforeEach(async () => {
    await run(noteWrite, {
      id: "retry-policy",
      title: "Retry policy",
      text: "Retries use exponential backoff with jitter. Never retry a billing error.",
      tags: ["ops"],
    });
    await run(noteWrite, {
      id: "deploy",
      title: "Deploy steps",
      text: "Deploy runs the migration first, then the worker rollout.",
      tags: ["ops", "release"],
    });
    await run(noteWrite, {
      id: "colours",
      title: "Brand",
      text: "The accent colour is teal.",
      tags: ["design"],
    });
  });

  test("writes, versions and replaces a note", async () => {
    expect(await run(noteWrite, { id: "x", text: "one" })).toMatchObject({
      version: 1,
      replaced: false,
    });
    expect(await run(noteWrite, { id: "x", text: "two" })).toMatchObject({
      version: 2,
      replaced: true,
    });
  });

  test("ifAbsent refuses to overwrite", async () => {
    expect(await run(noteWrite, { id: "deploy", text: "clobber", ifAbsent: true })).toMatchObject({
      written: false,
      exists: true,
    });
  });

  test("ranks the relevant note first and reports the parameters used", async () => {
    const out = await run(noteSearch, { query: "retry backoff" });
    expect(out.hits[0].id).toBe("retry-policy");
    expect(out.parameters).toEqual({ algorithm: "bm25", k1: 1.2, b: 0.75, lexicalOnly: true });
  });

  test("quotes a snippet around the match", async () => {
    const out = await run(noteSearch, { query: "jitter" });
    expect(out.hits[0].snippet).toContain("jitter");
    const none = await run(noteSearch, { query: "jitter", snippetChars: 0 });
    expect(none.hits[0].snippet).toBeUndefined();
  });

  test("matches the title and the tags, not only the body", async () => {
    expect((await run(noteSearch, { query: "brand" })).hits[0].id).toBe("colours");
    expect((await run(noteSearch, { query: "release" })).hits[0].id).toBe("deploy");
  });

  test("tags narrow the corpus before ranking", async () => {
    const out = await run(noteSearch, { query: "the", tags: ["design"] });
    expect(out.searched).toBe(1);
  });

  test("is lexical only — a synonym finds nothing, and it says which terms it knew", async () => {
    const out = await run(noteSearch, { query: "automobile" });
    expect(out.hits).toEqual([]);
    expect(out.unknownTerms).toEqual(["automobile"]);
  });

  test("searching an empty store is an empty result, not an error", async () => {
    const out = await run(noteSearch, { query: "anything", stateDir: "other" });
    expect(out).toMatchObject({ searched: 0, matched: 0, hits: [] });
  });

  test("a corrupt note is reported and the rest are still searched", async () => {
    writeFileSync(statePath("notes", "deploy.json"), "{{{");
    const out = await run(noteSearch, { query: "retry" });
    expect(out.searched).toBe(2);
    expect(out.corrupt[0].file).toBe("deploy.json");
  });

  test("the same search twice returns the same bytes", async () => {
    const a = await noteSearch.execute({ query: "retry backoff" });
    const b = await noteSearch.execute({ query: "retry backoff" });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------

describe("IndexBuild / IndexSearch", () => {
  beforeEach(() => {
    mkdirSync(path.join(tmp, "docs"), { recursive: true });
    writeFileSync(path.join(tmp, "docs/a.md"), "The parser reads tokens and builds a tree.");
    writeFileSync(path.join(tmp, "docs/b.md"), "The scheduler runs jobs on a queue.");
    writeFileSync(
      path.join(tmp, "docs/c.md"),
      "Queue draining is handled by the scheduler worker.",
    );
  });

  test("indexes files and finds the right one without reading them all", async () => {
    const built = await run(indexBuild, {
      name: "docs",
      paths: ["docs/a.md", "docs/b.md", "docs/c.md"],
    });
    expect(built).toMatchObject({ name: "docs", documents: 3 });
    const found = await run(indexSearch, { name: "docs", query: "parser tokens" });
    expect(found.hits[0].path).toBe("docs/a.md");
    expect(found.hits[0].file).toBe("current");
  });

  test("a query with no index at all says how to make one", async () => {
    expect(await run(indexSearch, { name: "missing", query: "x" })).toContain("IndexBuild first");
  });

  test("skips a path outside the workspace, a missing file and a binary one", async () => {
    writeFileSync(path.join(tmp, "docs/bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    const built = await run(indexBuild, {
      name: "docs",
      paths: ["docs/a.md", "../outside.md", "docs/nope.md", "docs/bin.dat"],
    });
    expect(built.documents).toBe(1);
    const reasons = Object.fromEntries(
      built.skipped.map((s: { path: string; reason: string }) => [s.path, s.reason]),
    );
    expect(reasons["../outside.md"]).toContain("outside the workspace");
    expect(reasons["docs/nope.md"]).toContain("no such file");
    expect(Object.values(reasons).join(" ")).toContain("NUL");
  });

  test("a file that changed since the build is flagged stale, not silently trusted", async () => {
    await run(indexBuild, { name: "docs", paths: ["docs/a.md", "docs/b.md"] });
    writeFileSync(path.join(tmp, "docs/a.md"), "Completely different contents now, much longer.");
    const found = await run(indexSearch, { name: "docs", query: "parser" });
    expect(found.hits[0]).toMatchObject({ path: "docs/a.md", file: "changed" });
    expect(found.stale).toEqual(["docs/a.md"]);
  });

  test("a file deleted since the build is reported as missing", async () => {
    await run(indexBuild, { name: "docs", paths: ["docs/a.md"] });
    rmSync(path.join(tmp, "docs/a.md"));
    const found = await run(indexSearch, { name: "docs", query: "parser" });
    expect(found.hits[0].file).toBe("missing");
  });

  test("snippets are opt-in and come from the file as it is now", async () => {
    await run(indexBuild, { name: "docs", paths: ["docs/b.md", "docs/c.md"] });
    const plain = await run(indexSearch, { name: "docs", query: "queue" });
    expect(plain.hits[0].snippet).toBeUndefined();
    const quoted = await run(indexSearch, { name: "docs", query: "queue", snippetChars: 120 });
    expect(quoted.hits[0].snippet).toContain("ueue");
  });

  test("duplicate paths are indexed once", async () => {
    const built = await run(indexBuild, { name: "docs", paths: ["docs/a.md", "docs/a.md"] });
    expect(built.documents).toBe(1);
  });

  test("a corrupt index file is reported with its path", async () => {
    await run(indexBuild, { name: "docs", paths: ["docs/a.md"] });
    writeFileSync(statePath("indexes", "docs.json"), '{"version":1}');
    expect(await run(indexSearch, { name: "docs", query: "x" })).toContain("not an inverted index");
  });

  test("building the same corpus twice writes the same index", async () => {
    const first = await run(indexBuild, { name: "docs", paths: ["docs/a.md", "docs/b.md"] });
    const bytes = readFileSync(statePath("indexes", "docs.json"), "utf8");
    const second = await run(indexBuild, { name: "docs", paths: ["docs/b.md", "docs/a.md"] });
    expect(readFileSync(statePath("indexes", "docs.json"), "utf8")).toBe(bytes);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------

describe("StateExport / StateImport", () => {
  beforeEach(async () => {
    await run(kvSet, { namespace: "n", key: "k", value: { a: 1 } });
    await run(counterIncrement, { name: "hits", by: 3 });
    await run(journalAppend, { stream: "runs", entry: { step: "a" } });
  });

  test("carries every state file, sorted, with a digest each", async () => {
    const out = await run(stateExport, {});
    expect(out.version).toBe(1);
    const paths = out.files.map((f: { path: string }) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("kv/n/k.json");
    expect(paths).toContain("counters/hits.json");
    expect(out.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a prefix narrows it, and includeContent: false gives an inventory", async () => {
    const kvOnly = await run(stateExport, { prefix: "kv/" });
    expect(kvOnly.files.every((f: { path: string }) => f.path.startsWith("kv/"))).toBe(true);
    const listing = await run(stateExport, { includeContent: false });
    expect(listing.files[0].content).toBeUndefined();
  });

  test("a binary state file is carried as base64", async () => {
    writeFileSync(statePath("blob.bin"), Buffer.from([0x00, 0xff, 0x10]));
    const out = await run(stateExport, { prefix: "blob" });
    expect(out.files[0].encoding).toBe("base64");
    expect(Buffer.from(out.files[0].content, "base64")).toEqual(Buffer.from([0x00, 0xff, 0x10]));
  });

  test("round-trips into a second state directory", async () => {
    const document = await run(stateExport, {});
    const imported = await run(stateImport, { document, stateDir: "backup" });
    expect(imported.written).toBe(document.fileCount);
    expect(await run(kvGet, { namespace: "n", key: "k", stateDir: "backup" })).toMatchObject({
      found: true,
      value: { a: 1 },
    });
    expect((await run(counterGet, { name: "hits", stateDir: "backup" })).value).toBe(3);
  });

  test("dryRun writes nothing but reports the whole plan", async () => {
    const document = await run(stateExport, {});
    const planned = await run(stateImport, { document, stateDir: "backup", dryRun: true });
    expect(planned.written).toBe(0);
    expect(planned.planned).toBe(document.fileCount);
    expect(await run(kvGet, { namespace: "n", key: "k", stateDir: "backup" })).toMatchObject({
      found: false,
    });
  });

  test("replace empties the target first; merge leaves the rest alone", async () => {
    const document = await run(stateExport, { prefix: "kv/" });
    await run(kvSet, { namespace: "n", key: "extra", value: 1, stateDir: "target" });
    await run(counterIncrement, { name: "local", stateDir: "target" });

    await run(stateImport, { document, stateDir: "target", mode: "merge" });
    expect((await run(counterGet, { name: "local", stateDir: "target" })).exists).toBe(true);

    await run(stateImport, { document, stateDir: "target", mode: "replace" });
    expect((await run(counterGet, { name: "local", stateDir: "target" })).exists).toBe(false);
    expect(await run(kvGet, { namespace: "n", key: "k", stateDir: "target" })).toMatchObject({
      found: true,
    });
  });

  test("an entry whose path would escape is refused, and nothing is written", async () => {
    const out = await run(stateImport, {
      document: {
        version: 1,
        files: [
          { path: "../escape.json", encoding: "utf8", content: "x" },
          { path: "kv/n/ok.json", encoding: "utf8", content: '{"key":"ok","value":1,"version":1}' },
        ],
      },
      stateDir: "target",
    });
    expect(out.refused[0]).toMatchObject({ path: "../escape.json" });
    expect(out.written).toBe(1);
    expect((await run(kvGet, { namespace: "n", key: "ok", stateDir: "target" })).found).toBe(true);
  });

  // `replace` is `rm -rf` on a directory the caller names. `stateDir: "."`
  // pointed it at the workspace.
  test("replace refuses the workspace root instead of deleting the workspace", async () => {
    mkdirSync(path.join(tmp, "src"), { recursive: true });
    writeFileSync(path.join(tmp, "src/app.ts"), "precious");
    const out = await run(stateImport, {
      document: { version: 1, files: [] },
      mode: "replace",
      stateDir: ".",
    });
    expect(out).toContain("will not replace the workspace root");
    expect(readFileSync(path.join(tmp, "src/app.ts"), "utf8")).toBe("precious");
  });

  test("replace refuses a directory that is not a state directory", async () => {
    mkdirSync(path.join(tmp, "work/lib"), { recursive: true });
    writeFileSync(path.join(tmp, "work/lib/deep.ts"), "precious");
    const out = await run(stateImport, {
      document: { version: 1, files: [] },
      mode: "replace",
      stateDir: "work",
    });
    expect(out).toContain("will not replace");
    expect(readFileSync(path.join(tmp, "work/lib/deep.ts"), "utf8")).toBe("precious");
  });

  test("replace still empties a real state directory, and leaves the directory itself", async () => {
    await run(kvSet, { namespace: "n", key: "gone", value: 1, stateDir: "target" });
    const out = await run(stateImport, {
      document: { version: 1, files: [] },
      mode: "replace",
      stateDir: "target",
    });
    expect(out.mode).toBe("replace");
    expect(readdirSync(path.join(tmp, "target"))).toEqual([]);
    expect((await run(kvGet, { namespace: "n", key: "gone", stateDir: "target" })).found).toBe(
      false,
    );
  });

  test("exporting a state directory that does not exist yet is empty, not an error", async () => {
    expect(await run(stateExport, { stateDir: "nothing-here" })).toMatchObject({
      fileCount: 0,
      files: [],
    });
  });
});

// ---------------------------------------------------------------------------

describe("DedupeMark", () => {
  test("the first sighting is new and the second is not", async () => {
    expect(await run(dedupeMark, { scope: "emails", id: "msg-1", now: T0 })).toEqual({
      scope: "emails",
      id: "msg-1",
      alreadySeen: false,
      marked: true,
    });
    const again = await run(dedupeMark, { scope: "emails", id: "msg-1", now: T2 });
    expect(again).toMatchObject({ alreadySeen: true, marked: false });
    expect(again.firstSeen).toMatchObject({ at: "2026-01-01T00:00:00.000Z" });
  });

  test("scopes are independent", async () => {
    await run(dedupeMark, { scope: "emails", id: "x" });
    expect(await run(dedupeMark, { scope: "tickets", id: "x" })).toMatchObject({
      alreadySeen: false,
    });
  });

  test("peek reports without marking", async () => {
    expect(await run(dedupeMark, { scope: "emails", id: "x", peek: true })).toMatchObject({
      alreadySeen: false,
      marked: false,
    });
    expect(await run(dedupeMark, { scope: "emails", id: "x" })).toMatchObject({
      alreadySeen: false,
      marked: true,
    });
  });

  test("a retry storm marks the id exactly once", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => run(dedupeMark, { scope: "emails", id: "same" })),
    );
    expect(results.filter((out) => out.marked === true).length).toBe(1);
    expect(results.filter((out) => out.alreadySeen === true).length).toBe(7);
  });

  test("the note from the first sighting is what later callers get back", async () => {
    await run(dedupeMark, { scope: "emails", id: "x", note: "sent by run 1" });
    const second = await run(dedupeMark, { scope: "emails", id: "x", note: "run 2" });
    expect(second.firstSeen.note).toBe("sent by run 1");
  });

  test("a corrupt mark is reported rather than treated as unseen", async () => {
    await run(dedupeMark, { scope: "emails", id: "x" });
    writeFileSync(statePath("dedupe", "emails", "x.json"), "{{{");
    expect(await run(dedupeMark, { scope: "emails", id: "x" })).toContain("is unusable");
  });
});

// ---------------------------------------------------------------------------

describe("size and sequence limits", () => {
  test("a note too large to be read back is refused rather than written", async () => {
    // Under the schema's 4M CHARACTER cap, but over the 4MB byte cap — and a
    // file over the read cap would come back as corrupt for ever after.
    const out = await run(noteWrite, { id: "big", text: "é".repeat(2_200_000) });
    expect(out).toContain("over the");
    expect(await run(noteSearch, { query: "anything" })).toMatchObject({ searched: 0 });
  });

  test("a stream whose sequence hint was lost still reports its real lastSeq", async () => {
    for (const step of ["a", "b", "c"]) {
      await run(journalAppend, { stream: "runs", entry: { step } });
    }
    rmSync(statePath("journal", "runs.jsonl.seq"));
    const listed = await run(journalRead, {});
    expect(listed.streams[0]).toMatchObject({ name: "runs", lastSeq: 3 });
    // And the next append continues from there rather than colliding.
    expect((await run(journalAppend, { stream: "runs", entry: { step: "d" } })).seq).toBe(4);
  });
});

// ---------------------------------------------------------------------------

describe("determinism", () => {
  test("an instant with no offset is read as UTC, not in the machine's zone", async () => {
    // Otherwise the same `now` stores a different expiry on a laptop in New
    // York than on a runner in UTC, and nothing here would be reproducible.
    const local = await run(kvSet, {
      namespace: "n",
      key: "local",
      value: 1,
      now: "2026-01-02T03:04:05",
      ttlSeconds: 60,
    });
    const utc = await run(kvSet, {
      namespace: "n",
      key: "utc",
      value: 1,
      now: "2026-01-02T03:04:05Z",
      ttlSeconds: 60,
    });
    expect(local.expiresAt).toBe("2026-01-02T03:05:05.000Z");
    expect(local.expiresAt).toBe(utc.expiresAt);
  });

  test("no tool writes the wall clock into a result the caller did not ask for", async () => {
    await run(kvSet, { namespace: "n", key: "k", value: 1 });
    await run(journalAppend, { stream: "s", entry: { a: 1 } });
    await run(noteWrite, { id: "n1", text: "alpha" });
    const thisYear = String(new Date().getFullYear());
    for (const call of [
      kvGet.execute({ namespace: "n", key: "k" }),
      journalRead.execute({ stream: "s" }),
      noteSearch.execute({ query: "alpha" }),
      checkpointList.execute({}),
      counterGet.execute({}),
    ]) {
      expect(String(await call)).not.toContain(thisYear);
    }
  });

  test("a state directory is only created when something is written to it", async () => {
    await run(kvGet, { namespace: "n", key: "k", stateDir: "lazy" });
    expect(readdirSync(tmp)).not.toContain("lazy");
  });
});
