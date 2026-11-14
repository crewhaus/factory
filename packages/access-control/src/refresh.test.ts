/**
 * Home's projection refresh: no actor, and still it writes only a governed harness whose
 * list differs from what the records give now; an idle check writes nothing at all.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { refreshApproverProjections } from "./access";
import { _setProjectionWriteTapForTest } from "./projection";
import { homeFixture, ok, readProjection, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);
afterEach(() => _setProjectionWriteTapForTest(undefined));

/** Every file under a directory, path to bytes. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "latin1");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("refreshApproverProjections", () => {
  test("refused nothing by actor, it writes only the governed harness whose list differs", async () => {
    const home = await homeFixture({ harnesses: [[], ["ops"], []] });
    const [h0, h1, h2] = home.harnesses;
    if (h0 === undefined || h1 === undefined || h2 === undefined) throw new Error("no harness");
    const ana = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: "group:ops",
      }),
    );
    ok(
      await home.access.grant(home.actor, {
        member: "Bo",
        create: true,
        role: "operator",
        scope: `harness:${h0.id}`,
      }),
    );
    const membersOf = (dir: { dir: string }) =>
      (readProjection(dir as never)["members"] as { principal: string }[]).map((m) => m.principal);
    expect(membersOf(h1)).toEqual([ana.principal]);
    const h0Before = readFileSync(join(h0.dir, ".crewhaus/run/control/approvers.json"), "utf8");
    // The registry moves h1 out of `ops` with no access write: only its list is behind.
    h1.groups.splice(0, 1);
    const writes: string[] = [];
    _setProjectionWriteTapForTest((harness) => writes.push(harness));
    const answer = await refreshApproverProjections(home.root, {
      harnesses: home.harnesses,
      now: home.clock.now(),
    });
    expect(answer.refreshed).toBe(true);
    expect(writes).toEqual([h1.id]);
    expect(membersOf(h1)).toEqual([]);
    expect(readFileSync(join(h0.dir, ".crewhaus/run/control/approvers.json"), "utf8")).toBe(
      h0Before,
    );
    // A harness nothing covers never gets a file.
    expect(existsSync(join(h2.dir, ".crewhaus/run/control/approvers.json"))).toBe(false);
  });

  test("with every list current, nothing is written: no lock, no revision move", async () => {
    const home = await homeFixture({ harnesses: [["ops"]] });
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: "group:ops",
      }),
    );
    const before = { access: tree(home.root), harnesses: home.harnesses.map((h) => tree(h.dir)) };
    const answer = await refreshApproverProjections(home.root, {
      harnesses: home.harnesses,
      now: home.clock.now(),
    });
    expect(answer).toEqual({
      refreshed: false,
      projections: { written: [], unchanged: [], failed: [] },
    });
    expect(tree(home.root)).toEqual(before.access);
    expect(home.harnesses.map((h) => tree(h.dir))).toEqual(before.harnesses);
  });

  test("over a Home nobody else has access to, it creates no file", async () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-absent-"));
    const harness = join(root, "h");
    mkdirSync(harness);
    const answer = await refreshApproverProjections(join(root, "hangar"), {
      harnesses: [{ id: "hrn_00000000000000aa", dir: harness, groups: [] }],
      now: Date.now(),
    });
    expect(answer.refreshed).toBe(false);
    expect(existsSync(join(root, "hangar"))).toBe(false);
    expect(readdirSync(harness)).toEqual([]);
  });
});
