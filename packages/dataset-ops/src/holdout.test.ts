/**
 * The holdout in dataset-ops: a four-share split spec, a seeded holdout cut into
 * a new version, and the registry-ref resolver that keeps the holdout off every
 * bare ref and reads it only for a promotion check or a holdout release, counting
 * each read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileBackedRegistry,
  heldOutUsesPath,
  readHeldOutUses,
} from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  DatasetRefError,
  createHoldoutVersion,
  parseRegistryRef,
  parseSplitSpec,
  refuseTestSplitRef,
  registerDataset,
  resolveRegistryRef,
  selectHoldout,
  splitSamples,
} from "./datasets";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dataset-ops-holdout-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const samples = (n: number): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, input: `q${i}` }));
const ids = (xs: ReadonlyArray<Sample> | undefined): string[] => (xs ?? []).map((x) => x.id);
const quiet = { warn: () => undefined };

describe("a four-share split spec", () => {
  test("parses train/dev/test/holdout, and three shares keep their shape", () => {
    expect(parseSplitSpec("60/15/15/10")).toEqual({ train: 60, dev: 15, test: 15, holdout: 10 });
    expect(parseSplitSpec("70/15/15")).toEqual({ train: 70, dev: 15, test: 15 });
    expect(() => parseSplitSpec("60/15/15/5")).toThrow(/must sum to 100/);
    expect(() => parseSplitSpec("1/1/1/1/96")).toThrow(DatasetRefError);
  });

  test("60/15/15/10 gives 60/15/25's train and dev, with the last tenth held out", async () => {
    const all = samples(40);
    const reg = createFileBackedRegistry({ rootDir: root });
    const four = await registerDataset({
      registry: reg,
      name: "four",
      samples: all,
      splitSpec: parseSplitSpec("60/15/15/10"),
      ...quiet,
    });
    const three = splitSamples(all, { train: 60, dev: 15, test: 25 });
    expect(ids(four.splits.train)).toEqual(ids(three.train));
    expect(ids(four.splits.dev)).toEqual(ids(three.dev));
    expect([...ids(four.splits.test), ...ids(four.splits.holdout)]).toEqual(ids(three.test));
    expect(four.splits.test).toHaveLength(6);
    expect(four.splits.holdout).toHaveLength(4);
  });

  test("a three-share spec writes the same record it always did, with no holdout key", async () => {
    const all = samples(20);
    const reg = createFileBackedRegistry({ rootDir: root });
    const rec = await registerDataset({
      registry: reg,
      name: "three",
      samples: all,
      splitSpec: parseSplitSpec("70/15/15"),
      ...quiet,
    });
    const want = splitSamples(all, { train: 70, dev: 15, test: 15 });
    expect(rec.splits).toEqual({ train: want.train, dev: want.dev, test: want.test });
    expect("holdout" in rec.splits).toBe(false);
    expect("holdout" in rec.sampleHashes).toBe(false);
  });

  test("--split holdout puts every case in the holdout", async () => {
    const reg = createFileBackedRegistry({ rootDir: root });
    const rec = await registerDataset({
      registry: reg,
      name: "only",
      samples: samples(3),
      split: "holdout",
      ...quiet,
    });
    expect(ids(rec.splits.holdout)).toEqual(["s0", "s1", "s2"]);
  });
});

describe("cutting a holdout into a new version", () => {
  async function seed(): Promise<void> {
    const reg = createFileBackedRegistry({ rootDir: root });
    await reg.put({
      name: "cases",
      version: "v1",
      splits: {
        train: samples(10),
        dev: samples(14).slice(10),
        test: [{ id: "t1", input: "x" }],
      },
    });
  }

  test("the same ids in another order give the same holdout, never from test", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    const record = await reg.getRecord("cases", "v1");
    const shuffled = {
      ...record,
      splits: {
        ...record.splits,
        train: [...record.splits.train].reverse(),
        dev: [...record.splits.dev].reverse(),
      },
    };
    expect(selectHoldout(record, 0.25, "seed-1")).toEqual(selectHoldout(shuffled, 0.25, "seed-1"));
    expect(selectHoldout(record, 0.25, "seed-1")).toHaveLength(Math.ceil(0.25 * 14));
    const before = readFileSync(join(root, "cases", "v1.json"));
    const made = await createHoldoutVersion({
      registry: reg,
      name: "cases",
      fraction: 0.25,
      seed: "seed-1",
    });
    expect(made.source).toBe("v1");
    expect(made.record.version).toBe("v2");
    expect(ids(made.record.splits.test)).toEqual(["t1"]);
    expect(ids(made.record.splits.holdout)).not.toContain("t1");
    expect(made.moved).toBe(4);
    expect(made.record.splits.train.length + made.record.splits.dev.length).toBe(10);
    // The source version is untouched.
    expect(readFileSync(join(root, "cases", "v1.json")).equals(before)).toBe(true);
  });

  test("refuses a fraction out of range, a second holdout, and an empty train or dev", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    for (const fraction of [0, -0.1, 0.51, 1, Number.NaN]) {
      await expect(
        createHoldoutVersion({ registry: reg, name: "cases", fraction }),
      ).rejects.toThrow(/fraction/);
    }
    await reg.put({
      name: "tiny",
      version: "v1",
      splits: { train: samples(1), dev: [{ id: "d", input: "d" }] },
    });
    await expect(
      createHoldoutVersion({ registry: reg, name: "tiny", fraction: 0.5 }),
    ).rejects.toThrow(/empty (train|dev)/);
    await createHoldoutVersion({ registry: reg, name: "cases", fraction: 0.2 });
    await expect(
      createHoldoutVersion({ registry: reg, name: "cases", version: "v2", fraction: 0.2 }),
    ).rejects.toThrow(/already has a holdout/);
  });
});

describe("resolving a registry ref keeps the holdout to its two readers", () => {
  async function seed(): Promise<void> {
    const reg = createFileBackedRegistry({ rootDir: root });
    await reg.put({
      name: "cases",
      version: "v1",
      splits: {
        train: [{ id: "a", input: "a" }],
        dev: [{ id: "b", input: "b" }],
        test: [{ id: "t", input: "t" }],
        holdout: [{ id: "h", input: "h" }],
      },
    });
  }

  test("a bare ref selects train and dev only, and the notice names both held-out splits", async () => {
    await seed();
    const notes: string[] = [];
    const reg = createFileBackedRegistry({ rootDir: root });
    const resolved = await resolveRegistryRef(
      reg,
      { name: "cases" },
      { warn: (l) => notes.push(l) },
    );
    expect(resolved.splits).toEqual(["train", "dev"]);
    expect(ids(resolved.samples)).toEqual(["a", "b"]);
    expect(notes.join(" ")).toContain("a locked test split and a holdout");
    expect(existsSync(heldOutUsesPath(root, "cases", "v1"))).toBe(false);
  });

  test("#holdout is refused for an eval and a canary, and named in the ref grammar", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    const ref = parseRegistryRef("registry:cases#holdout");
    expect(ref?.split).toBe("holdout");
    await expect(
      resolveRegistryRef(reg, ref as never, {
        allowTestSplit: true,
        use: { purpose: "eval", via: "cli" },
      }),
    ).rejects.toThrow(/crewhaus changes check/);
    expect(() => parseRegistryRef("registry:cases#nope")).toThrow(/#holdout/);
    expect(() => refuseTestSplitRef("optimize", ref as never)).toThrow(
      /never runs over the holdout/,
    );
    expect(existsSync(heldOutUsesPath(root, "cases", "v1"))).toBe(false);
  });

  test("a promotion read is accepted and leaves one line carrying its change", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    const chg = "chg_01m76e6f05hp514w9j4v3qymka";
    const resolved = await resolveRegistryRef(
      reg,
      { name: "cases", split: "holdout" },
      { heldOut: { purpose: "promotion" }, use: { purpose: "promotion", via: "cli", change: chg } },
    );
    expect(ids(resolved.samples)).toEqual(["h"]);
    const report = readHeldOutUses(root, "cases", "v1");
    expect(report.uses).toHaveLength(1);
    expect(report.uses[0]).toMatchObject({ split: "holdout", purpose: "promotion", change: chg });
  });

  test("a test read records its use, with the run it names", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    await resolveRegistryRef(
      reg,
      { name: "cases", split: "test" },
      { allowTestSplit: true, use: { purpose: "eval", via: "cli", runId: "run_0123456789abcdef" } },
    );
    const report = readHeldOutUses(root, "cases", "v1");
    expect(report.uses.map((u) => [u.split, u.purpose, u.runId])).toEqual([
      ["test", "eval", "run_0123456789abcdef"],
    ]);
  });

  test("a read that may reach a held-out split without saying what it is for is refused", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    await expect(
      resolveRegistryRef(reg, { name: "cases", split: "test" }, { allowTestSplit: true } as never),
    ).rejects.toThrow(/must say what it is for/);
    expect(existsSync(heldOutUsesPath(root, "cases", "v1"))).toBe(false);
  });

  test("a registry that cannot record a use does not hand back the held-out cases", async () => {
    await seed();
    const real = createFileBackedRegistry({ rootDir: root });
    const { recordUse: _drop, ...noRecorder } = real;
    await expect(
      resolveRegistryRef(
        noRecorder,
        { name: "cases", split: "test" },
        {
          allowTestSplit: true,
          use: { purpose: "eval", via: "cli" },
        },
      ),
    ).rejects.toThrow(/cannot record a held-out use/);
  });
});

describe("a held-out case stays held out across versions", () => {
  test("the version a holdout was cut from is not read, and the holdout's version is", async () => {
    const reg = createFileBackedRegistry({ rootDir: root });
    await reg.put({
      name: "cases",
      version: "v1",
      splits: { train: samples(8), dev: samples(10).slice(8) },
    });
    const cut = await createHoldoutVersion({ registry: reg, name: "cases", fraction: 0.3 });
    const heldOut = ids(cut.record.splits.holdout);
    expect(heldOut.length).toBeGreaterThan(0);
    for (const ref of ["registry:cases@v1", "registry:cases@v1#train", "registry:cases@v1#dev"]) {
      const parsed = parseRegistryRef(ref);
      if (parsed === undefined) throw new Error(ref);
      const read = resolveRegistryRef(reg, parsed, quiet);
      // Only the splits that hold a held-out case are refused.
      const split = parsed.split;
      const holds =
        split === undefined ||
        ids((await reg.getRecord("cases", "v1")).splits[split]).some((id) => heldOut.includes(id));
      if (holds) {
        await expect(read).rejects.toThrow(/keeps out, so it is not read/);
        await expect(read).rejects.toThrow("registry:cases@v2");
      } else {
        expect(ids((await read).samples).some((id) => heldOut.includes(id))).toBe(false);
      }
    }
    const latest = await resolveRegistryRef(reg, { name: "cases" }, quiet);
    expect(latest.version).toBe("v2");
    expect(ids(latest.samples).some((id) => heldOut.includes(id))).toBe(false);
  });

  test("a later version that dropped the holdout is not read either", async () => {
    const reg = createFileBackedRegistry({ rootDir: root });
    await reg.put({
      name: "cases",
      version: "v1",
      splits: { train: samples(8), dev: samples(10).slice(8) },
    });
    await createHoldoutVersion({ registry: reg, name: "cases", fraction: 0.3 });
    await reg.put({
      name: "cases",
      version: "v3",
      splits: { train: samples(8), dev: samples(10).slice(8) },
    });
    await expect(resolveRegistryRef(reg, { name: "cases" }, quiet)).rejects.toThrow(
      /"cases@v3" holds \d+ case\(s\) the holdout of "cases@v2" keeps out/,
    );
  });
});
