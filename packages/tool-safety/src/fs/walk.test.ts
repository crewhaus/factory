import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, mkfifo, posix } from "./test-helpers";
import { walkContained } from "./walk";

const f = fixture("walk");
afterAll(() => {
  try {
    chmodSync(join(f.ws, "t", "locked"), 0o755);
  } catch {
    // never locked
  }
  f.cleanup();
});

// t/
//   b.txt, a.txt, sub/c.txt, sub/deeper/d.txt, empty/
mkdirSync(join(f.ws, "t", "sub", "deeper"), { recursive: true });
mkdirSync(join(f.ws, "t", "empty"));
writeFileSync(join(f.ws, "t", "b.txt"), "bb");
writeFileSync(join(f.ws, "t", "a.txt"), "a");
writeFileSync(join(f.ws, "t", "sub", "c.txt"), "ccc");
writeFileSync(join(f.ws, "t", "sub", "deeper", "d.txt"), "d");
mkdirSync(join(f.outside, "tree"));
writeFileSync(join(f.outside, "tree", "stolen.txt"), "s");

const rels = (r: ReturnType<typeof walkContained>): string[] =>
  r.ok ? r.entries.map((e) => e.rel) : [];

describe("walkContained", () => {
  test("lists depth-first in plain sorted order, with kinds and sizes", () => {
    const r = walkContained(f.ws, "t", { maxEntries: 100, maxDepth: 10 });
    expect(r).toMatchObject({ ok: true, truncated: false, unreadable: [] });
    expect(rels(r)).toEqual([
      "a.txt",
      "b.txt",
      "empty",
      "sub",
      "sub/c.txt",
      "sub/deeper",
      "sub/deeper/d.txt",
    ]);
    if (!r.ok) return;
    const c = r.entries.find((e) => e.rel === "sub/c.txt");
    expect(c).toMatchObject({ kind: "file", size: 3, depth: 2, path: "t/sub/c.txt" });
    expect(c?.real).toBe(join(realpathSync(f.ws), "t", "sub", "c.txt"));
    expect(r.entries.find((e) => e.rel === "sub")).toMatchObject({ kind: "directory", size: 0 });
  });

  test("maxEntries truncates; exactly maxEntries does not", () => {
    const all = walkContained(f.ws, "t", { maxEntries: 7, maxDepth: 10 });
    expect(all).toMatchObject({ ok: true, truncated: false });
    const cut = walkContained(f.ws, "t", { maxEntries: 3, maxDepth: 10 });
    expect(cut).toMatchObject({ ok: true, truncated: true, truncatedBy: "max-entries" });
    expect(rels(cut)).toEqual(["a.txt", "b.txt", "empty"]);
  });

  test("maxDepth stops descent, and says so only when something was left unlisted", () => {
    const one = walkContained(f.ws, "t", { maxEntries: 100, maxDepth: 1 });
    expect(rels(one)).toEqual(["a.txt", "b.txt", "empty", "sub"]);
    expect(one).toMatchObject({ truncated: true, truncatedBy: "max-depth" });
    mkdirSync(join(f.ws, "flat", "hollow"), { recursive: true });
    expect(walkContained(f.ws, "flat", { maxEntries: 100, maxDepth: 1 })).toMatchObject({
      ok: true,
      truncated: false,
    });
  });

  test("filter: skip hides an entry but descends; prune hides the subtree", () => {
    const skip = walkContained(f.ws, "t", {
      maxEntries: 100,
      maxDepth: 10,
      filter: (e) => (e.rel === "sub" ? "skip" : "keep"),
    });
    expect(rels(skip)).toContain("sub/c.txt");
    expect(rels(skip)).not.toContain("sub");
    const prune = walkContained(f.ws, "t", {
      maxEntries: 100,
      maxDepth: 10,
      filter: (e) => (e.rel === "sub" ? "prune" : "keep"),
    });
    expect(rels(prune)).toEqual(["a.txt", "b.txt", "empty"]);
  });

  test("maxVisited bounds a walk whose filter keeps nothing", () => {
    const r = walkContained(f.ws, "t", {
      maxEntries: 100,
      maxDepth: 10,
      maxVisited: 3,
      filter: () => "skip",
    });
    expect(r).toMatchObject({ ok: true, truncated: true, truncatedBy: "max-visited", entries: [] });
  });

  test("budgets that are not numbers, or a request to follow links, are thrown", () => {
    // A NaN budget compares false with everything: the walk never stopped.
    expect(() => walkContained(f.ws, "t", { maxEntries: Number.NaN, maxDepth: 10 })).toThrow(
      "maxEntries must be a number >= 0",
    );
    expect(() =>
      walkContained(f.ws, "t", { maxEntries: 10, maxDepth: undefined as unknown as number }),
    ).toThrow("maxDepth must be a number >= 0");
    expect(() =>
      walkContained(f.ws, "t", {
        maxEntries: 10,
        maxDepth: 1,
        followSymlinks: true as unknown as false,
      }),
    ).toThrow("never follows symbolic links");
  });

  test("the start must be a contained directory", () => {
    expect(walkContained(f.ws, "t/a.txt", { maxEntries: 5, maxDepth: 1 })).toMatchObject({
      ok: false,
      code: "not-directory",
      kind: "file",
    });
    expect(walkContained(f.ws, "..", { maxEntries: 5, maxDepth: 1 })).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    expect(walkContained(f.ws, "nope", { maxEntries: 5, maxDepth: 1 })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });
});

describe.if(posix)("walkContained never follows a link, and names special files", () => {
  test("links are reported as links, with where they lead; an escaping one is not descended", () => {
    mkdirSync(join(f.ws, "L"));
    symlinkSync("../t/sub", join(f.ws, "L", "in-dir"));
    symlinkSync(join(f.outside, "tree"), join(f.ws, "L", "out-dir"));
    symlinkSync("../../outside/nothing-here", join(f.ws, "L", "out-dangling"));
    symlinkSync("missing.txt", join(f.ws, "L", "in-dangling"));
    const r = walkContained(f.ws, "L", { maxEntries: 100, maxDepth: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byRel = Object.fromEntries(r.entries.map((e) => [e.rel, e]));
    expect(Object.keys(byRel)).toEqual(["in-dangling", "in-dir", "out-dangling", "out-dir"]);
    expect(byRel["in-dir"]).toMatchObject({
      kind: "symlink",
      link: { text: "../t/sub", inside: true, dangling: false },
    });
    expect(byRel["out-dir"]).toMatchObject({ kind: "symlink", link: { inside: false } });
    expect(byRel["out-dangling"]).toMatchObject({ link: { inside: false, dangling: true } });
    expect(byRel["in-dangling"]).toMatchObject({ link: { inside: true, dangling: true } });
    // Nothing under either linked directory was listed.
    expect(r.entries.some((e) => e.rel.includes("stolen") || e.rel.includes("c.txt"))).toBe(false);
  });

  test("where a link leads is resolved as the kernel does, not by folding its text", () => {
    // W/k/l/y -> ../../.. is the root itself; W/x -> k/l/y/.. then climbs
    // from the root, out of it. The text folds to W/k/l, inside.
    mkdirSync(join(f.ws, "W", "k", "l"), { recursive: true });
    symlinkSync("../../..", join(f.ws, "W", "k", "l", "y"));
    symlinkSync("k/l/y/..", join(f.ws, "W", "x"));
    const r = walkContained(f.ws, "W", { maxEntries: 100, maxDepth: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.find((e) => e.rel === "x")).toMatchObject({
      kind: "symlink",
      link: { text: "k/l/y/..", inside: false },
    });
  });

  test("the start may be reached through an in-root link", () => {
    const r = walkContained(f.ws, "L/in-dir", { maxEntries: 100, maxDepth: 10 });
    expect(rels(r)).toEqual(["c.txt", "deeper", "deeper/d.txt"]);
    expect(walkContained(f.ws, "L/out-dir", { maxEntries: 5, maxDepth: 1 })).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
  });

  test("a FIFO is listed as a fifo, and the walk does not block on it", () => {
    mkdirSync(join(f.ws, "pipes"));
    mkfifo(join(f.ws, "pipes", ".gitignore"));
    const r = walkContained(f.ws, "pipes", { maxEntries: 10, maxDepth: 2 });
    expect(r).toMatchObject({ ok: true, entries: [{ rel: ".gitignore", kind: "fifo", size: 0 }] });
  });

  test.if(process.getuid?.() !== 0)(
    "an unreadable directory is reported, not silently empty",
    () => {
      mkdirSync(join(f.ws, "t", "locked"));
      writeFileSync(join(f.ws, "t", "locked", "x"), "x");
      chmodSync(join(f.ws, "t", "locked"), 0o000);
      const r = walkContained(f.ws, "t", { maxEntries: 100, maxDepth: 10 });
      expect(r).toMatchObject({
        ok: true,
        unreadable: [{ rel: "locked", reason: "permission-denied" }],
      });
      chmodSync(join(f.ws, "t", "locked"), 0o755);
    },
  );
});
