/**
 * One tab never mixes two releases of Home: once the version Home answers differs from
 * the one the tab booted on, the next navigation loads the page whole at its address and
 * imports no screen of the new release; a version that cannot be read changes nothing;
 * and a tab that comes back to a new release shows the banner and loads nothing, so an
 * unsaved edit stays.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { createVersionGuard, guardedLoad, tabHasDraft } from "../assets/js/ui/version-guard.js";

/** A version read that answers each of `answers` in turn, then the last one again. */
function versions(...answers: Array<string | Error>) {
  let i = 0;
  return async () => {
    const next = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return { hangar: next, protocolV: 1 };
  };
}

describe("the version guard", () => {
  test("a new version makes the next navigation load the page whole, importing nothing", async () => {
    const loads: string[] = [];
    let imports = 0;
    const guard = createVersionGuard({
      readVersion: versions("0.9.0", "0.9.1"),
      fullLoad: (target: string) => loads.push(target),
    });
    await guard.boot();
    const mod = await guardedLoad(
      guard,
      async () => {
        imports += 1;
        return { renderThing: () => {} };
      },
      "#/harnesses/spend",
    );
    expect(mod).toBeNull();
    expect(imports).toBe(0);
    expect(loads).toEqual(["#/harnesses/spend"]);
    expect(guard.changed()).toBe(true);
  });

  test("the same version imports the screen as usual", async () => {
    const loads: string[] = [];
    const guard = createVersionGuard({
      readVersion: versions("0.9.0", "0.9.0"),
      fullLoad: (target: string) => loads.push(target),
    });
    await guard.boot();
    expect(await guardedLoad(guard, async () => "module", "#/")).toBe("module");
    expect(loads).toEqual([]);
  });

  test("a version that cannot be read changes nothing", async () => {
    const loads: string[] = [];
    const guard = createVersionGuard({
      readVersion: versions("0.9.0", new Error("offline"), "0.9.0"),
      fullLoad: (target: string) => loads.push(target),
    });
    await guard.boot();
    expect(await guardedLoad(guard, async () => "a", "#/a")).toBe("a");
    expect(await guardedLoad(guard, async () => "b", "#/b")).toBe("b");
    expect(loads).toEqual([]);
    expect(guard.changed()).toBe(false);
  });

  test("a resumed tab on a new release shows the banner once and loads nothing", async () => {
    const loads: string[] = [];
    const shown: Array<{ draft: boolean }> = [];
    const guard = createVersionGuard({
      readVersion: versions("0.9.0", "0.9.1"),
      fullLoad: (target: string) => loads.push(target),
      onUpdated: (info: { draft: boolean }) => shown.push(info),
      hasDraft: () => true,
    });
    await guard.boot();
    await guard.resumed();
    await guard.resumed();
    expect(shown).toEqual([{ draft: true }]);
    expect(loads).toEqual([]);
  });

  test("a tab holds a draft when its session storage has one", () => {
    const storage = (keys: string[]) => ({
      length: keys.length,
      key: (i: number) => keys[i] ?? null,
    });
    expect(tabHasDraft(storage(["hangar.session", "hangar.draft.#/x.note"]))).toBe(true);
    expect(tabHasDraft(storage(["hangar.session"]))).toBe(false);
  });
});
