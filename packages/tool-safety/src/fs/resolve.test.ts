import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { physicalFrom, physicalPath, resolveContained } from "./resolve";
import { fixture, posix } from "./test-helpers";

const f = fixture("resolve");
afterAll(() => f.cleanup());
const wsReal = realpathSync(f.ws);

describe("resolveContained", () => {
  test("a plain path resolves to its physical form, with a lexical rel", () => {
    mkdirSync(join(f.ws, "plain"));
    writeFileSync(join(f.ws, "plain", "a.txt"), "a");
    const r = resolveContained(f.ws, "plain/./a.txt");
    expect(r).toMatchObject({ ok: true, rel: "plain/a.txt", real: join(wsReal, "plain", "a.txt") });
  });

  test("a missing tail is allowed, so a destination can be checked before it exists", () => {
    const r = resolveContained(f.ws, "not/yet/there.json");
    expect(r).toMatchObject({ ok: true, real: join(wsReal, "not", "yet", "there.json") });
  });

  test("lexical escapes are refused, naming the caller's path and not the resolved one", () => {
    for (const given of ["../outside/secret.txt", join(f.outside, "secret.txt"), "a/../../x"]) {
      const r = resolveContained(f.ws, given);
      expect(r).toMatchObject({ ok: false, code: "escapes-root", path: given });
      if (!r.ok) {
        expect(r.reason).toContain(JSON.stringify(given));
        expect(r.reason).toContain("escapes the workspace");
      }
    }
  });

  test("an absolute path spelled through the root's realpath is the same place", () => {
    const r = resolveContained(f.ws, join(wsReal, "plain"));
    expect(r).toMatchObject({ ok: true, rel: "plain" });
  });

  test("an empty path or a NUL byte is refused as invalid", () => {
    expect(resolveContained(f.ws, "")).toMatchObject({ ok: false, code: "invalid-path" });
    expect(resolveContained(f.ws, "a\u0000b")).toMatchObject({ ok: false, code: "invalid-path" });
  });

  test("a missing root is reported, not thrown", () => {
    expect(resolveContained(join(f.base, "no-such-root"), "x")).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });
});

describe.if(posix)("resolveContained follows links the way the kernel does", () => {
  test("an in-root link is followed; one leading out is refused without naming its target", () => {
    writeFileSync(join(f.ws, "inside.txt"), "in");
    symlinkSync("inside.txt", join(f.ws, "ok-link"));
    symlinkSync(join(f.outside, "secret.txt"), join(f.ws, "out-link"));
    expect(resolveContained(f.ws, "ok-link")).toMatchObject({
      ok: true,
      real: join(wsReal, "inside.txt"),
    });
    const r = resolveContained(f.ws, "out-link");
    expect(r).toMatchObject({ ok: false, code: "escapes-root" });
    if (!r.ok) {
      expect(r.reason).not.toContain(f.outside);
      expect(r.reason).not.toContain("outside/secret");
      expect(r.reason).not.toContain("TOP-SECRET");
    }
  });

  test("a DANGLING link out is refused: open(O_CREAT) through it would create the target", () => {
    // security-7#0's shape: baselines.json -> ../../outside/pwned.json, target absent.
    mkdirSync(join(f.ws, "evals"));
    symlinkSync("../../outside/pwned.json", join(f.ws, "evals", "baselines.json"));
    expect(resolveContained(f.ws, "evals/baselines.json")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    // A dangling link that stays inside resolves to where it would create.
    symlinkSync("later.json", join(f.ws, "evals", "pending.json"));
    expect(resolveContained(f.ws, "evals/pending.json")).toMatchObject({
      ok: true,
      real: join(wsReal, "evals", "later.json"),
    });
  });

  test("followLeaf:false keeps the link itself as the leaf", () => {
    const r = resolveContained(f.ws, "out-link", { followLeaf: false });
    expect(r).toMatchObject({ ok: true, real: join(wsReal, "out-link") });
  });

  test("a relative target resolves against the link's REAL directory, not its lexical parent", () => {
    // ws/p -> a/b; ws/a/b/r -> ../c. Through p, `r` really lands at ws/a/c.
    // Measured from the lexical parent (ws/p) it would read as ws/c.
    mkdirSync(join(f.ws, "a", "b"), { recursive: true });
    symlinkSync("a/b", join(f.ws, "p"));
    symlinkSync("../c", join(f.ws, "a", "b", "r"));
    expect(resolveContained(f.ws, "p/r")).toMatchObject({ ok: true, real: join(wsReal, "a", "c") });
  });

  test("`..` after a link climbs from the link's target (security-11#5)", () => {
    // ws/k/l/y -> ../.. (that is, ws). The text `k/l/y/..` folds to `k/l`,
    // but the kernel follows y to ws first, and `..` of ws is outside.
    mkdirSync(join(f.ws, "k", "l"), { recursive: true });
    symlinkSync("../..", join(f.ws, "k", "l", "y"));
    expect(physicalFrom(wsReal, "k/l/y/..")).toBe(dirname(wsReal));
    symlinkSync("k/l/y/..", join(f.ws, "x"));
    expect(resolveContained(f.ws, "x")).toMatchObject({ ok: false, code: "escapes-root" });
    // The same chain one level shallower stays inside.
    symlinkSync("k/l/y/k", join(f.ws, "x2"));
    expect(resolveContained(f.ws, "x2")).toMatchObject({ ok: true, real: join(wsReal, "k") });
  });

  test("`..` out of a missing component re-probes, so a later link on the way is followed", () => {
    // L -> nothere/../out-link: dangling today, but once `nothere` exists
    // it leads through out-link to the outside. Folding the text after the
    // missing component would call it inside.
    symlinkSync("nothere/../out-link", join(f.ws, "L"));
    expect(resolveContained(f.ws, "L")).toMatchObject({ ok: false, code: "escapes-root" });
    expect(physicalFrom(wsReal, "nothere/../plain")).toBe(join(wsReal, "plain"));
  });

  test("a link loop is refused as a link problem, not thrown", () => {
    symlinkSync("loop-b", join(f.ws, "loop-a"));
    symlinkSync("loop-a", join(f.ws, "loop-b"));
    const r = resolveContained(f.ws, "loop-a");
    expect(r).toMatchObject({ ok: false, code: "is-symlink" });
    if (!r.ok) expect(r.reason).toContain("loop");
    expect(() => physicalPath(join(wsReal, "loop-a"))).toThrow();
  });

  test("a root reached through a link still contains its own paths", () => {
    symlinkSync(f.ws, join(f.base, "ws-alias"));
    const r = resolveContained(join(f.base, "ws-alias"), "plain/a.txt");
    expect(r).toMatchObject({ ok: true, real: join(wsReal, "plain", "a.txt") });
    expect(resolveContained(join(f.base, "ws-alias"), "out-link")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
  });
});
