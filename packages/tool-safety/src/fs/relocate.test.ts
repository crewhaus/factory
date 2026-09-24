import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkRelocatedLinks } from "./relocate";
import { fixture, posix } from "./test-helpers";

const f = fixture("relocate");
afterAll(() => f.cleanup());

describe.if(posix)("checkRelocatedLinks", () => {
  test("a link that stays inside from its new place passes; one that would leave is refused (security-11#2)", () => {
    // ws/a/b/up -> ../..  leads to ws/ now; moved to ws/b it would lead above ws.
    mkdirSync(join(f.ws, "a", "b"), { recursive: true });
    symlinkSync("../..", join(f.ws, "a", "b", "up"));
    expect(checkRelocatedLinks(f.ws, "a/b", f.ws, "a/c")).toMatchObject({ ok: true, links: 1 });
    const moved = checkRelocatedLinks(f.ws, "a/b", f.ws, "b");
    expect(moved).toMatchObject({ ok: false, code: "escapes-root", path: "a/b/up" });
    if (!moved.ok) {
      expect(moved.reason).toContain('"b/up"');
      // The outside place is never named.
      expect(moved.reason).not.toContain(f.base);
    }
  });

  test("a chain through another link in the moved tree is resolved as the kernel will", () => {
    // t/hop -> x/..  and  t/x -> ../..  : from t2/hop, x climbs two levels
    // first, then `..` climbs one more.
    mkdirSync(join(f.ws, "deep", "t"), { recursive: true });
    symlinkSync("../..", join(f.ws, "deep", "t", "x"));
    symlinkSync("x/..", join(f.ws, "deep", "t", "hop"));
    // At deep/t: x -> ws, hop -> above ws already.
    expect(checkRelocatedLinks(f.ws, "deep/t", f.ws, "deep/u")).toMatchObject({
      ok: false,
      path: "deep/t/hop",
    });
    mkdirSync(join(f.ws, "deep", "one", "two"), { recursive: true });
    // One level deeper, x leads to deep/, and hop to ws/: both inside.
    expect(checkRelocatedLinks(f.ws, "deep/t", f.ws, "deep/one/two/t")).toMatchObject({
      ok: true,
      links: 2,
    });
  });

  test("a link moved on its own is judged at its destination", () => {
    symlinkSync("../sibling", join(f.ws, "a", "solo"));
    expect(checkRelocatedLinks(f.ws, "a/solo", f.ws, "a/b/solo")).toMatchObject({ ok: true });
    expect(checkRelocatedLinks(f.ws, "a/solo", f.ws, "solo")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
  });

  test("across roots, every link is judged against the destination root", () => {
    mkdirSync(join(f.ws, "other-root", "in"), { recursive: true });
    mkdirSync(join(f.ws, "tree"));
    symlinkSync(join(f.ws, "a"), join(f.ws, "tree", "to-a"));
    // Inside ws, which is the source root; outside other-root, the destination's.
    expect(checkRelocatedLinks(f.ws, "tree", join(f.ws, "other-root"), "in/tree")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
  });

  test("no content budget: a large tree with few links passes, and the link and entry caps hold", () => {
    mkdirSync(join(f.ws, "big"));
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(f.ws, "big", `pkg${d}`));
      for (let i = 0; i < 50; i++) writeFileSync(join(f.ws, "big", `pkg${d}`, `f${i}.js`), "");
    }
    symlinkSync("../pkg1", join(f.ws, "big", "pkg0", "sibling"));
    symlinkSync("../pkg2", join(f.ws, "big", "pkg1", "sibling"));
    expect(checkRelocatedLinks(f.ws, "big", f.ws, "big2")).toMatchObject({
      ok: true,
      links: 2,
      visited: 20 + 20 * 50 + 2,
    });
    expect(checkRelocatedLinks(f.ws, "big", f.ws, "big2", { maxLinks: 1 })).toMatchObject({
      ok: false,
      code: "too-large",
    });
    expect(checkRelocatedLinks(f.ws, "big", f.ws, "big2", { maxVisited: 100 })).toMatchObject({
      ok: false,
      code: "too-large",
    });
    expect(() => checkRelocatedLinks(f.ws, "big", f.ws, "big2", { maxLinks: Number.NaN })).toThrow(
      RangeError,
    );
  });

  test("the source and destination are contained, and a tree cannot move into itself", () => {
    expect(checkRelocatedLinks(f.ws, "../outside", f.ws, "x")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    expect(checkRelocatedLinks(f.ws, "a", f.ws, "../x")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    expect(checkRelocatedLinks(f.ws, "a", f.ws, "a/inner")).toMatchObject({
      ok: false,
      code: "overlaps-source",
    });
    expect(checkRelocatedLinks(f.ws, "", f.ws, "x")).toMatchObject({
      ok: false,
      code: "invalid-path",
    });
  });
});
