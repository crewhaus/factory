/**
 * A change to the access records lands only when every row it plans is a well-formed row of
 * its ledger: one malformed row refuses the whole change, and nothing is written.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type AccessContext, type PlannedRow, runMutation } from "./mutate";
import { accessPaths } from "./paths";
import { loadAccessSnapshot } from "./snapshot";
import { homeFixture, removeTempDirs, treeOf } from "./test-helpers";

afterAll(removeTempDirs);

async function fixture() {
  const home = await homeFixture();
  const ctx: AccessContext = {
    root: home.root,
    now: home.clock.now,
    harnesses: () => home.harnesses,
    domains: new Map(),
  };
  const owner = home.snapshot().principals.find((p) => p.id === home.owner);
  if (owner === undefined) throw new Error("no owner row");
  return { home, ctx, owner };
}

describe("runMutation writes only well-formed rows", () => {
  test("a member principals row carrying a scoped epoch is refused, and nothing is written", async () => {
    const { home, ctx, owner } = await fixture();
    const accessDir = join(home.root, accessPaths().dir);
    const before = treeOf(accessDir);
    const epoch = home.snapshot().epoch;
    const answer = await runMutation(
      ctx,
      home.actor,
      (state) => ({
        rows: [
          {
            kind: "principals",
            row: { ...owner, scopedEpoch: 1, at: state.at, by: state.by },
          } satisfies PlannedRow,
        ],
        result: undefined,
      }),
      { projections: false },
    );
    expect(answer).toMatchObject({ ok: false, code: "invalid" });
    expect(answer.ok ? "" : answer.reason).toContain("principals");
    expect(answer.ok ? "" : answer.reason).toContain("nothing was written");
    expect(treeOf(accessDir)).toEqual(before);
    const read = loadAccessSnapshot(home.root);
    expect(read.state).toBe("present");
    expect(read.state === "present" ? read.snapshot.epoch : undefined).toBe(epoch);
  });

  test("one malformed row among well-formed ones refuses the whole change", async () => {
    const { home, ctx, owner } = await fixture();
    const accessDir = join(home.root, accessPaths().dir);
    const before = treeOf(accessDir);
    const answer = await runMutation(
      ctx,
      home.actor,
      (state) => ({
        rows: [
          { kind: "principals", row: { ...owner, at: state.at, by: state.by } },
          { kind: "grants", row: { id: "grt_not-one", at: state.at, by: state.by } },
        ],
        result: undefined,
      }),
      { projections: false },
    );
    expect(answer).toMatchObject({ ok: false, code: "invalid" });
    expect(answer.ok ? "" : answer.reason).toContain("grants");
    expect(treeOf(accessDir)).toEqual(before);
  });

  test("a well-formed planned row lands and moves the revision", async () => {
    const { home, ctx, owner } = await fixture();
    const epoch = home.snapshot().epoch;
    const answer = await runMutation(
      ctx,
      home.actor,
      (state) => ({
        rows: [{ kind: "principals", row: { ...owner, at: state.at, by: state.by } }],
        result: "landed",
      }),
      { projections: false },
    );
    expect(answer).toMatchObject({ ok: true, result: "landed" });
    expect(home.snapshot().epoch).toBeGreaterThan(epoch);
  });
});
