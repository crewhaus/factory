/**
 * Agent dataset tools stay out of the holdout: `DatasetInspect` counts it and
 * checks its hashes but returns no id and no PII location from it, `DatasetLint`
 * leaves it out of the linted set, and `DatasetPut` writes no holdout itself,
 * carries a previous version's holdout forward without reading it back, and
 * answers the same whether or not an incoming id is held out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createFileBackedRegistry } from "@crewhaus/dataset-registry";
import { datasetInspect, datasetLint, datasetPut } from "./index";

const originalCwd = process.cwd();
const originalDatasetsDir = process.env["CREWHAUS_DATASETS_DIR"];
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-dataset-holdout-"));
  process.chdir(tmp);
  Reflect.deleteProperty(process.env, "CREWHAUS_DATASETS_DIR");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  if (originalDatasetsDir === undefined)
    Reflect.deleteProperty(process.env, "CREWHAUS_DATASETS_DIR");
  else process.env["CREWHAUS_DATASETS_DIR"] = originalDatasetsDir;
});

// biome-ignore lint/suspicious/noExplicitAny: a tool returns JSON text; the tests read it as data
type Json = any;

async function run(
  tool: { execute: (i: never) => Promise<unknown> },
  input: unknown,
): Promise<string> {
  return String(await tool.execute(input as never));
}

const REGISTRY = ".crewhaus/datasets";
const HELD_ID = "held-out-secret-case";
// A secret-shaped value built from parts, so no real-shaped literal sits in the source.
const SECRET = `${"AKIA"}${"IOSFODNN7"}${"EXAMPLE"}`;

async function seed(): Promise<void> {
  const reg = createFileBackedRegistry({ rootDir: path.join(tmp, REGISTRY) });
  await reg.put({
    name: "cases",
    version: "v1",
    splits: {
      train: [{ id: "train-1", input: "hello" }],
      dev: [{ id: "dev-1", input: "there" }],
      test: [{ id: "test-1", input: "general" }],
      holdout: [{ id: HELD_ID, input: `my key is ${SECRET}`, expected_output: "x" }],
    },
  });
}

describe("DatasetInspect", () => {
  test("returns no holdout id or PII location, whatever allowTestSplit says, and still counts its hits", async () => {
    await seed();
    const out = await run(datasetInspect, {
      dataset: "cases",
      allowTestSplit: true,
      includeSampleIds: true,
    });
    expect(out).not.toContain(HELD_ID);
    const result = JSON.parse(out) as Json;
    expect(result.splits.holdout).toMatchObject({ count: 1, golds: 1, detailWithheld: true });
    expect(result.splits.holdout.ids).toBeUndefined();
    expect(result.holdout).toMatchObject({ present: true, detailWithheld: true });
    expect(result.hashes.status).toBe("verified");
    expect(result.pii.totalHits).toBeGreaterThan(0);
    expect(result.pii.heldOutHits).toBeGreaterThan(0);
    for (const hit of result.pii.hits as Json[]) expect(hit.sampleId).not.toBe(HELD_ID);
    // The test split's detail is still the caller's to ask for.
    expect(result.splits.test.ids).toEqual(["test-1"]);
  });

  test("a #holdout ref is refused and names the person's way in", async () => {
    await seed();
    const out = await run(datasetInspect, { dataset: "cases#holdout" });
    expect(out).toContain("names the holdout");
    expect(out).toContain("crewhaus datasets");
    expect(out).not.toContain(HELD_ID);
  });
});

describe("DatasetLint", () => {
  test("leaves the holdout out of the linted set and reports it as a count", async () => {
    await seed();
    const out = await run(datasetLint, { dataset: "cases" });
    expect(out).not.toContain(HELD_ID);
    const result = JSON.parse(out) as Json;
    expect(result.sampleCount).toBe(3);
    expect(result.holdout).toMatchObject({ count: 1, excluded: true });
  });

  test("a #holdout ref is refused", async () => {
    await seed();
    const out = await run(datasetLint, { dataset: "registry:cases#holdout" });
    expect(out).toContain("names the holdout");
    expect(out).toContain("crewhaus datasets");
  });
});

describe("DatasetPut", () => {
  test("refuses split: holdout and a four-share split spec", async () => {
    await seed();
    const one = await run(datasetPut, {
      name: "cases",
      samples: [{ id: "n1", input: "a" }],
      split: "holdout",
    });
    expect(one).toContain("writes train, dev and test only");
    expect(one).toContain("crewhaus datasets");
    // The schema the catalog validates against names three splits.
    expect(
      datasetPut.inputSchema.safeParse({ name: "cases", samples: [], split: "holdout" }).success,
    ).toBe(false);
    const four = await run(datasetPut, {
      name: "cases",
      samples: [{ id: "n1", input: "a" }],
      splitSpec: "60/15/15/10",
    });
    expect(four).toContain("names a holdout share");
    expect(four).toContain("crewhaus datasets");
  });

  test("a re-put carries the holdout rows forward and its result names none of them", async () => {
    await seed();
    const out = await run(datasetPut, {
      name: "cases",
      samples: [
        { id: "train-1", input: "hello" },
        { id: "dev-1", input: "there" },
        { id: "test-1", input: "general" },
        { id: "new-1", input: "fresh" },
      ],
    });
    expect(out).not.toContain(HELD_ID);
    const result = JSON.parse(out) as Json;
    expect(result.wrote).toBe(true);
    expect(result.holdout).toMatchObject({ count: 1, carriedForward: true });
    expect(result.stability.droppedCount).toBe(0);
    const v2 = JSON.parse(
      readFileSync(path.join(tmp, REGISTRY, "cases", "v2.json"), "utf8"),
    ) as Json;
    expect(v2.splits.holdout.map((s: Json) => s.id)).toEqual([HELD_ID]);
    // Carried as it was, byte for byte.
    expect(v2.splits.holdout[0].input).toBe(`my key is ${SECRET}`);
  });

  test("recompute never moves a holdout row", async () => {
    await seed();
    const out = await run(datasetPut, {
      name: "cases",
      samples: [
        { id: "a", input: "1" },
        { id: "b", input: "2" },
        { id: "c", input: "3" },
      ],
      splitMode: "recompute",
    });
    expect(out).not.toContain(HELD_ID);
    const v2 = JSON.parse(
      readFileSync(path.join(tmp, REGISTRY, "cases", "v2.json"), "utf8"),
    ) as Json;
    expect(v2.splits.holdout.map((s: Json) => s.id)).toEqual([HELD_ID]);
  });
});

describe("a case held out by a later version", () => {
  const LATER_HELD = "later-held-case";
  /** v1 lists LATER_HELD in train; v2, cut from it, holds it out. */
  async function seedCut(): Promise<void> {
    const reg = createFileBackedRegistry({ rootDir: path.join(tmp, REGISTRY) });
    await reg.put({
      name: "cases",
      version: "v1",
      splits: {
        train: [
          { id: "train-1", input: "hello" },
          { id: LATER_HELD, input: `my key is ${SECRET}` },
        ],
        dev: [{ id: "dev-1", input: "there" }],
      },
    });
    await reg.put({
      name: "cases",
      version: "v2",
      splits: {
        train: [{ id: "train-1", input: "hello" }],
        dev: [{ id: "dev-1", input: "there" }],
        holdout: [{ id: LATER_HELD, input: `my key is ${SECRET}` }],
      },
    });
  }

  test("DatasetInspect of the version it was cut from names it nowhere", async () => {
    await seedCut();
    const out = await run(datasetInspect, {
      dataset: "cases@v1",
      allowTestSplit: true,
      includeSampleIds: true,
    });
    expect(out).not.toContain(LATER_HELD);
    const result = JSON.parse(out) as Json;
    expect(result.splits.train).toMatchObject({ count: 2, heldOutRows: 1, ids: ["train-1"] });
    expect(result.pii.heldOutHits).toBeGreaterThan(0);
  });

  test("DatasetLint of the version it was cut from leaves it out", async () => {
    await seedCut();
    const out = await run(datasetLint, { dataset: "cases@v1" });
    expect(out).not.toContain(LATER_HELD);
    expect((JSON.parse(out) as Json).holdout).toMatchObject({ count: 1, excluded: true });
  });

  test("DatasetPut based on the version it was cut from carries the newest holdout as it was, and keeps the caller's sample beside it", async () => {
    await seedCut();
    const out = await run(datasetPut, {
      name: "cases",
      basedOn: "v1",
      samples: [
        { id: "train-1", input: "hello" },
        { id: "dev-1", input: "there" },
        { id: LATER_HELD, input: `my key is ${SECRET}` },
      ],
    });
    const result = JSON.parse(out) as Json;
    expect(result.wrote).toBe(true);
    expect(result.holdout).toEqual({
      count: 1,
      carriedForward: true,
      note: "the dataset's holdout is carried as it was — its rows are never returned to an agent",
    });
    expect(result.sampleCount).toBe(3);
    expect(result.stability.droppedCount).toBe(0);
    const v2 = JSON.parse(
      readFileSync(path.join(tmp, REGISTRY, "cases", "v2.json"), "utf8"),
    ) as Json;
    const v3 = JSON.parse(
      readFileSync(path.join(tmp, REGISTRY, "cases", "v3.json"), "utf8"),
    ) as Json;
    expect(v3.splits.holdout).toEqual(v2.splits.holdout);
    const others = [...v3.splits.train, ...v3.splits.dev, ...(v3.splits.test ?? [])] as Json[];
    expect(others.map((s) => s.id)).not.toContain(LATER_HELD);
    expect(others.filter((s) => s.input === `my key is ${SECRET}`)).toHaveLength(1);
  });
});

describe("DatasetPut answers the same whether or not an incoming id is held out", () => {
  const X = "case-x";
  const Z = "case-z";
  const PUT = { id: X, input: `my key is ${SECRET}`, expected_output: "y" };

  /** v1 lists `held` in train beside three other cases; v2 holds it out. */
  async function seedHolding(held: string): Promise<void> {
    const reg = createFileBackedRegistry({ rootDir: path.join(process.cwd(), REGISTRY) });
    const rows = [
      { id: "a-1", input: "one" },
      { id: "a-2", input: "two" },
    ];
    await reg.put({
      name: "cases",
      version: "v1",
      splits: {
        train: [...rows, { id: held, input: "held case" }],
        dev: [{ id: "d-1", input: "three" }],
        test: [{ id: "t-1", input: "four" }],
      },
    });
    await reg.put({
      name: "cases",
      version: "v2",
      splits: {
        train: rows,
        dev: [{ id: "d-1", input: "three" }],
        test: [{ id: "t-1", input: "four" }],
        holdout: [{ id: held, input: "held case" }],
      },
    });
  }

  /** Run `input` against a registry holding out `held`, in its own directory. */
  async function inRegistry(held: string, inputs: unknown[]): Promise<Json[]> {
    const dir = path.join(tmp, held);
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    try {
      if (!existsSync(path.join(dir, REGISTRY))) await seedHolding(held);
      const outs: Json[] = [];
      for (const input of inputs) outs.push(JSON.parse(await run(datasetPut, input)) as Json);
      return outs;
    } finally {
      process.chdir(tmp);
    }
  }

  const without = (r: Json, ...keys: string[]): Json => {
    const copy = { ...r };
    for (const k of keys) delete copy[k];
    return copy;
  };

  test("a dry run returns the same result for a held-out id as for an unknown one, apart from the hash", async () => {
    const input = { name: "cases", samples: [PUT, { id: "n-1", input: "five" }], dryRun: true };
    const [a] = await inRegistry(X, [input]);
    const [b] = await inRegistry(Z, [input]);
    expect(a.wrote).toBe(false);
    expect(without(a, "datasetHash")).toEqual(without(b, "datasetHash"));
    expect(a.pii.hits.map((h: Json) => h.sampleId)).toContain(X);
  });

  test("a write returns the same result for a held-out id as for an unknown one, apart from the hash and time", async () => {
    const input = { name: "cases", samples: [PUT, { id: "n-1", input: "five" }] };
    const [a] = await inRegistry(X, [input]);
    const [b] = await inRegistry(Z, [input]);
    expect(a.wrote).toBe(true);
    expect(without(a, "datasetHash", "createdAt")).toEqual(without(b, "datasetHash", "createdAt"));
  });

  test("the written version keeps the holdout as it was and stores the caller's sample under another id", async () => {
    const [a] = await inRegistry(X, [{ name: "cases", samples: [PUT] }]);
    expect(a.wrote).toBe(true);
    const at = (v: string): Json =>
      JSON.parse(readFileSync(path.join(tmp, X, REGISTRY, "cases", `${v}.json`), "utf8")) as Json;
    const v3 = at("v3");
    expect(v3.splits.holdout).toEqual(at("v2").splits.holdout);
    const others = [...v3.splits.train, ...v3.splits.dev, ...(v3.splits.test ?? [])] as Json[];
    const mine = others.filter((s) => s.input === PUT.input);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).not.toBe(X);
    expect(v3.splits.holdout.map((s: Json) => s.id)).not.toContain(mine[0].id);
    expect(mine[0].expected_output).toBe("y");
  });

  test("the dataset hash is the same on repeated calls and does not single out a held-out id", async () => {
    const content = { input: `my key is ${SECRET}`, expected_output: "y" };
    const pair = [
      { name: "cases", split: "train", samples: [{ id: X, ...content }], dryRun: true },
      { name: "cases", split: "train", samples: [{ id: `${X}~v3`, ...content }], dryRun: true },
    ];
    const [a1, a2] = await inRegistry(X, pair);
    const [b1, b2] = await inRegistry(Z, pair);
    expect(a1.datasetHash).not.toBe(a2.datasetHash);
    expect(b1.datasetHash).not.toBe(b2.datasetHash);
    const [again1, again2] = await inRegistry(X, [pair[0], pair[0]]);
    expect(again1).toEqual(again2);
    expect(again1).toEqual(a1);
  });
});
