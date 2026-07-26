/**
 * Unit tests for the item-12 dataset-registry CLI plumbing: ref parsing,
 * deterministic splits, version bumping, `registry:` resolution (datasetName
 * + datasetHash keying for the item-3 run index), promotion via
 * `registerDataset` (the engine behind `datasets put` and
 * `distill --register`), and the `datasets get` JSONL serializer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DatasetRegistry, createFileBackedRegistry } from "@crewhaus/dataset-registry";
import { type Sample, SampleSchema } from "@crewhaus/eval-dataset";
import {
  DEFAULT_SPLIT_SPEC,
  DatasetRefError,
  canaryPhrase,
  canarySample,
  inspectRegistryRef,
  nextVersion,
  overallDatasetHash,
  parseNameVersion,
  parseRegistryRef,
  parseSplitSpec,
  promoteVerifiedSynthetics,
  recordToJsonl,
  refuseTestSplitRef,
  registerDataset,
  registryDatasetName,
  resolveRegistryRef,
  splitSamples,
} from "./datasets";
import { type FeedbackRecord, type SessionTurn, distill } from "./feedback";

const TMP_ROOTS: string[] = [];
function newRegistry(): DatasetRegistry {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-datasets-"));
  TMP_ROOTS.push(dir);
  return createFileBackedRegistry({ rootDir: dir });
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const sample = (id: string, input = `input-${id}`): Sample => ({ id, input });
const samples = (n: number): Sample[] => Array.from({ length: n }, (_, i) => sample(`s${i}`));

describe("parseRegistryRef", () => {
  test("returns undefined for non-registry values (bare paths keep working)", () => {
    expect(parseRegistryRef("data/eval.jsonl")).toBeUndefined();
    expect(parseRegistryRef("./registry.jsonl")).toBeUndefined();
    expect(parseRegistryRef("https://example.com/d.jsonl")).toBeUndefined();
  });

  test("parses name, name@version, name#split, and name@version#split", () => {
    expect(parseRegistryRef("registry:support")).toEqual({ name: "support" });
    expect(parseRegistryRef("registry:support@v3")).toEqual({ name: "support", version: "v3" });
    expect(parseRegistryRef("registry:support#dev")).toEqual({ name: "support", split: "dev" });
    expect(parseRegistryRef("registry:support@v3#test")).toEqual({
      name: "support",
      version: "v3",
      split: "test",
    });
  });

  test("rejects a bad split, empty name, and empty version", () => {
    expect(() => parseRegistryRef("registry:x#validation")).toThrow(DatasetRefError);
    expect(() => parseRegistryRef("registry:")).toThrow(DatasetRefError);
    expect(() => parseRegistryRef("registry:#train")).toThrow(DatasetRefError);
    expect(() => parseRegistryRef("registry:x@")).toThrow(DatasetRefError);
  });
});

describe("parseNameVersion", () => {
  test("splits on the first @ and tolerates its absence", () => {
    expect(parseNameVersion("support")).toEqual({ name: "support" });
    expect(parseNameVersion("support@v2")).toEqual({ name: "support", version: "v2" });
  });

  test("rejects an empty version", () => {
    expect(() => parseNameVersion("support@")).toThrow(DatasetRefError);
  });
});

describe("parseSplitSpec", () => {
  test("accepts train/dev/test and train/dev forms summing to 100", () => {
    expect(parseSplitSpec("70/15/15")).toEqual({ train: 70, dev: 15, test: 15 });
    expect(parseSplitSpec("80/20")).toEqual({ train: 80, dev: 20, test: 0 });
    expect(parseSplitSpec("100/0/0")).toEqual({ train: 100, dev: 0, test: 0 });
  });

  test("rejects wrong arity, non-integers, and sums ≠ 100", () => {
    expect(() => parseSplitSpec("70")).toThrow(DatasetRefError);
    expect(() => parseSplitSpec("70/15/10/5")).toThrow(DatasetRefError);
    expect(() => parseSplitSpec("70/15/14")).toThrow(DatasetRefError);
    expect(() => parseSplitSpec("70/-15/45")).toThrow(DatasetRefError);
    expect(() => parseSplitSpec("seventy/15/15")).toThrow(DatasetRefError);
    expect(() => parseSplitSpec("70.5/14.5/15")).toThrow(DatasetRefError);
  });
});

describe("splitSamples — deterministic assignment", () => {
  test("partitions every sample exactly once at the percentage boundaries", () => {
    const input = samples(10);
    const { train, dev, test } = splitSamples(input, DEFAULT_SPLIT_SPEC);
    // n=10 at 70/15/15: boundaries floor(7)=7 and floor(8.5)=8.
    expect(train).toHaveLength(7);
    expect(dev).toHaveLength(1);
    expect(test).toHaveLength(2);
    const ids = [...train, ...dev, ...test].map((s) => s.id).sort();
    expect(ids).toEqual(input.map((s) => s.id).sort());
  });

  test("is independent of input order (stable by sample-id hash, not position)", () => {
    const input = samples(20);
    const shuffled = [...input].reverse();
    const a = splitSamples(input, DEFAULT_SPLIT_SPEC);
    const b = splitSamples(shuffled, DEFAULT_SPLIT_SPEC);
    expect(a.train.map((s) => s.id)).toEqual(b.train.map((s) => s.id));
    expect(a.dev.map((s) => s.id)).toEqual(b.dev.map((s) => s.id));
    expect(a.test.map((s) => s.id)).toEqual(b.test.map((s) => s.id));
  });

  test("is stable across repeated calls (no RNG anywhere)", () => {
    const input = samples(13);
    const a = splitSamples(input, { train: 60, dev: 20, test: 20 });
    const b = splitSamples(input, { train: 60, dev: 20, test: 20 });
    expect(a).toEqual(b);
  });

  test("a sample keeps its relative hash-order position between runs", () => {
    // Same ids → same canonical order, so growing the dataset only moves
    // samples near the shifted boundaries, never reshuffles arbitrarily.
    const a = splitSamples(samples(10), { train: 50, dev: 50, test: 0 });
    const b = splitSamples(samples(10), { train: 50, dev: 50, test: 0 });
    expect(a.train.map((s) => s.id)).toEqual(b.train.map((s) => s.id));
  });

  test("100/0/0 puts everything in train; a 2-part spec leaves test empty", () => {
    const all = splitSamples(samples(5), { train: 100, dev: 0, test: 0 });
    expect(all.train).toHaveLength(5);
    expect(all.dev).toHaveLength(0);
    expect(all.test).toHaveLength(0);
    const noTest = splitSamples(samples(9), parseSplitSpec("70/30"));
    expect(noTest.test).toHaveLength(0);
    expect(noTest.train.length + noTest.dev.length).toBe(9);
  });

  test("empty input yields three empty splits", () => {
    expect(splitSamples([], DEFAULT_SPLIT_SPEC)).toEqual({ train: [], dev: [], test: [] });
  });
});

describe("nextVersion", () => {
  test("starts at v1 and bumps past the highest vN", () => {
    expect(nextVersion([])).toBe("v1");
    expect(nextVersion(["v1"])).toBe("v2");
    expect(nextVersion(["v1", "v2", "v10"])).toBe("v11");
  });

  test("ignores versions outside the vN grammar", () => {
    expect(nextVersion(["1.0.0"])).toBe("v1");
    expect(nextVersion(["1.0.0", "v3", "v2-rc1"])).toBe("v4");
  });
});

describe("registerDataset — versioned promotion", () => {
  test("first put lands as v1 with the deterministic default split", async () => {
    const registry = newRegistry();
    const rec = await registerDataset({ registry, name: "support", samples: samples(10) });
    expect(rec.version).toBe("v1");
    expect(rec.splits.train).toHaveLength(7);
    expect(rec.splits.dev).toHaveLength(1);
    expect(rec.splits.test).toHaveLength(2);
    // Persisted, not just returned.
    expect(await registry.list("support")).toEqual(["v1"]);
  });

  test("subsequent puts auto-bump (v1 → v2), leaving v1 intact", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "support", samples: samples(4) });
    const rec2 = await registerDataset({ registry, name: "support", samples: samples(6) });
    expect(rec2.version).toBe("v2");
    expect((await registry.list("support")).sort()).toEqual(["v1", "v2"]);
    expect((await registry.getRecord("support", "v1")).createdAt).toBeDefined();
  });

  test("--split mode puts every sample into the one named split", async () => {
    const registry = newRegistry();
    const dev = await registerDataset({ registry, name: "d", samples: samples(3), split: "dev" });
    expect(dev.splits.train).toHaveLength(0);
    expect(dev.splits.dev).toHaveLength(3);
    expect(dev.splits.test).toBeUndefined();
    const testRec = await registerDataset({
      registry,
      name: "t",
      samples: samples(2),
      split: "test",
    });
    expect(testRec.splits.test).toHaveLength(2);
    expect(testRec.splits.train).toHaveLength(0);
    expect(testRec.splits.dev).toHaveLength(0);
  });

  test("a 0% test spec omits the test split key entirely", async () => {
    const registry = newRegistry();
    const rec = await registerDataset({
      registry,
      name: "no-test",
      samples: samples(10),
      splitSpec: parseSplitSpec("70/30"),
    });
    expect(rec.splits.test).toBeUndefined();
    expect(rec.sampleHashes.test).toBeUndefined();
  });
});

describe("resolveRegistryRef — the registry: shorthand", () => {
  test("defaults to the latest version and the train+dev union (B16: test stays locked)", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "s", samples: samples(4) });
    const v2 = await registerDataset({ registry, name: "s", samples: samples(10) });
    const resolved = await resolveRegistryRef(registry, { name: "s" });
    expect(resolved.version).toBe("v2");
    expect(resolved.datasetName).toBe("s@v2");
    expect(resolved.splits).toEqual(["train", "dev"]);
    // 10 samples at 70/15/15 → 7 train + 1 dev; the 2 test rows are excluded.
    expect(resolved.samples).toHaveLength(8);
    // Union preserves canonical train → dev order.
    expect(resolved.samples.map((s) => s.id)).toEqual(
      [...v2.splits.train, ...v2.splits.dev].map((s) => s.id),
    );
  });

  test("B16 — a bare ref on a record WITH a test split warns once (injected sink)", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "warned", samples: samples(10) });
    const warned: string[] = [];
    await resolveRegistryRef(registry, { name: "warned" }, { warn: (l) => warned.push(l) });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("warned@v1");
    expect(warned[0]).toContain("test split");
    expect(warned[0]).toContain("--allow-test-split");
  });

  test("B16 — a bare ref on a test-less record neither warns nor changes shape", async () => {
    const registry = newRegistry();
    await registerDataset({
      registry,
      name: "no-test",
      samples: samples(10),
      splitSpec: parseSplitSpec("70/30"),
    });
    const warned: string[] = [];
    const resolved = await resolveRegistryRef(
      registry,
      { name: "no-test" },
      { warn: (l) => warned.push(l) },
    );
    expect(warned).toHaveLength(0);
    expect(resolved.splits).toEqual(["train", "dev"]);
    expect(resolved.samples).toHaveLength(10);
  });

  test("B16 — an explicit #test throws without allowTestSplit and resolves with it", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "locked", samples: samples(10) });
    expect(resolveRegistryRef(registry, { name: "locked", split: "test" })).rejects.toThrow(
      "--allow-test-split",
    );
    const resolved = await resolveRegistryRef(
      registry,
      { name: "locked", split: "test" },
      { allowTestSplit: true },
    );
    expect(resolved.splits).toEqual(["test"]);
    expect(resolved.datasetName).toBe("locked@v1#test");
    expect(resolved.samples.map((s) => s.id)).toEqual(
      (resolved.record.splits.test ?? []).map((s) => s.id),
    );
  });

  test("B16 — the #test lock fires before the registry lookup (no versions needed)", async () => {
    const registry = newRegistry();
    expect(resolveRegistryRef(registry, { name: "ghost", split: "test" })).rejects.toBeInstanceOf(
      DatasetRefError,
    );
    // With the opt-in, the same ref reaches the normal versionless error.
    expect(
      resolveRegistryRef(registry, { name: "ghost", split: "test" }, { allowTestSplit: true }),
    ).rejects.toThrow("no versions");
  });

  test("B16 — bare-ref datasetHash covers exactly train+dev", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "hashed", samples: samples(10) });
    const resolved = await resolveRegistryRef(registry, { name: "hashed" }, { warn: () => {} });
    expect(resolved.datasetHash).toBe(overallDatasetHash(resolved.record, ["train", "dev"]));
    expect(resolved.datasetHash).not.toBe(
      overallDatasetHash(resolved.record, ["train", "dev", "test"]),
    );
  });

  test("pins an explicit version and an explicit split (with #split in the name)", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "s", samples: samples(10) });
    await registerDataset({ registry, name: "s", samples: samples(20) });
    const resolved = await resolveRegistryRef(registry, { name: "s", version: "v1", split: "dev" });
    expect(resolved.version).toBe("v1");
    expect(resolved.datasetName).toBe("s@v1#dev");
    expect(resolved.samples.map((s) => s.id)).toEqual(resolved.record.splits.dev.map((s) => s.id));
  });

  test("throws DatasetRefError for a versionless dataset and a missing split", async () => {
    const registry = newRegistry();
    expect(resolveRegistryRef(registry, { name: "ghost" })).rejects.toBeInstanceOf(DatasetRefError);
    await registerDataset({
      registry,
      name: "no-test",
      samples: samples(10),
      splitSpec: parseSplitSpec("70/30"),
    });
    expect(resolveRegistryRef(registry, { name: "no-test", split: "test" })).rejects.toBeInstanceOf(
      DatasetRefError,
    );
  });

  test("datasetHash is stable, split-scoped, and content-derived", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "h", samples: samples(10) });
    const all1 = await resolveRegistryRef(registry, { name: "h" });
    const all2 = await resolveRegistryRef(registry, { name: "h" });
    const devOnly = await resolveRegistryRef(registry, { name: "h", split: "dev" });
    expect(all1.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(all1.datasetHash).toBe(all2.datasetHash);
    expect(devOnly.datasetHash).not.toBe(all1.datasetHash);
    // New content → new hash (fresh lineage for the item-3 baseline diff).
    await registerDataset({ registry, name: "h", samples: samples(11) });
    const v2 = await resolveRegistryRef(registry, { name: "h" });
    expect(v2.datasetHash).not.toBe(all1.datasetHash);
  });
});

describe("inspectRegistryRef — read-side resolution stays split-complete", () => {
  test("a bare ref selects EVERY split present — the locked test split included", async () => {
    const registry = newRegistry();
    const rec = await registerDataset({ registry, name: "insp", samples: samples(10) });
    const inspected = await inspectRegistryRef(registry, { name: "insp" });
    expect(inspected.splits).toEqual(["train", "dev", "test"]);
    // 10 samples at 70/15/15 → all 10 come back (consumption would see 8).
    expect(inspected.samples).toHaveLength(10);
    expect(inspected.samples.map((s) => s.id)).toEqual(
      [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])].map((s) => s.id),
    );
    expect(inspected.datasetName).toBe("insp@v1");
  });

  test("an explicit #test resolves without any opt-in (inspection is not consumption)", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "insp-t", samples: samples(10) });
    const inspected = await inspectRegistryRef(registry, { name: "insp-t", split: "test" });
    expect(inspected.splits).toEqual(["test"]);
    expect(inspected.datasetName).toBe("insp-t@v1#test");
    expect(inspected.samples.map((s) => s.id)).toEqual(
      (inspected.record.splits.test ?? []).map((s) => s.id),
    );
  });

  test("throws DatasetRefError for a versionless dataset and a missing split", async () => {
    const registry = newRegistry();
    expect(inspectRegistryRef(registry, { name: "ghost" })).rejects.toBeInstanceOf(DatasetRefError);
    await registerDataset({
      registry,
      name: "insp-no-test",
      samples: samples(10),
      splitSpec: parseSplitSpec("70/30"),
    });
    expect(
      inspectRegistryRef(registry, { name: "insp-no-test", split: "test" }),
    ).rejects.toBeInstanceOf(DatasetRefError);
  });
});

describe("refuseTestSplitRef — optimize/flywheel never touch the holdout (B16)", () => {
  test("throws DatasetRefError on #test, naming the refusing command", () => {
    for (const command of ["optimize", "flywheel"] as const) {
      expect(() => refuseTestSplitRef(command, { name: "s", split: "test" })).toThrow(
        DatasetRefError,
      );
      expect(() => refuseTestSplitRef(command, { name: "s", split: "test" })).toThrow(
        `${command} never runs over the test split`,
      );
    }
  });

  test("bare, #train, and #dev refs pass through untouched", () => {
    expect(() => refuseTestSplitRef("optimize", { name: "s" })).not.toThrow();
    expect(() => refuseTestSplitRef("optimize", { name: "s", split: "train" })).not.toThrow();
    expect(() => refuseTestSplitRef("flywheel", { name: "s", split: "dev" })).not.toThrow();
  });
});

describe("overallDatasetHash + registryDatasetName", () => {
  test("hash ignores the splits-array order but not the split identity", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "o", samples: samples(10) });
    const { record } = await resolveRegistryRef(registry, { name: "o" });
    expect(overallDatasetHash(record, ["dev", "train"])).toBe(
      overallDatasetHash(record, ["train", "dev"]),
    );
    expect(overallDatasetHash(record, ["train"])).not.toBe(overallDatasetHash(record, ["dev"]));
  });

  test("registryDatasetName folds in the optional split", () => {
    expect(registryDatasetName("s", "v2")).toBe("s@v2");
    expect(registryDatasetName("s", "v2", "train")).toBe("s@v2#train");
  });
});

describe("recordToJsonl — datasets get serialization", () => {
  test("single split prints SampleSchema-valid lines verbatim", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "j", samples: samples(10) });
    const { record } = await resolveRegistryRef(registry, { name: "j" });
    const lines = recordToJsonl(record, "train").trim().split("\n");
    expect(lines).toHaveLength(record.splits.train.length);
    for (const line of lines) {
      const parsed = SampleSchema.parse(JSON.parse(line));
      expect(parsed.id).toMatch(/^s\d+$/);
    }
    expect(JSON.parse(lines[0] as string)).not.toHaveProperty("split");
  });

  test("merged output tags every line with a split column and still round-trips", async () => {
    const registry = newRegistry();
    await registerDataset({ registry, name: "j2", samples: samples(10) });
    const { record } = await resolveRegistryRef(registry, { name: "j2" });
    const lines = recordToJsonl(record).trim().split("\n");
    expect(lines).toHaveLength(10);
    const bySplit = { train: 0, dev: 0, test: 0 };
    for (const line of lines) {
      const obj = JSON.parse(line) as { split: keyof typeof bySplit };
      bySplit[obj.split] += 1;
      // SampleSchema strips the extra column — merged output stays loadable.
      expect(() => SampleSchema.parse(obj)).not.toThrow();
    }
    expect(bySplit).toEqual({ train: 7, dev: 1, test: 2 });
  });

  test("an empty record serializes to the empty string", async () => {
    const registry = newRegistry();
    const rec = await registry.put({
      name: "empty",
      version: "v1",
      splits: { train: [], dev: [] },
    });
    expect(recordToJsonl(rec)).toBe("");
  });
});

describe("distill → registerDataset (the --register pipeline)", () => {
  const SESSION = "sess_0123456789abcdef";
  const turn = (n: number, input: string, output: string): SessionTurn => ({
    sessionId: SESSION,
    turnNumber: n,
    input,
    output,
    toolNames: [],
  });
  const rating = (n: number, thumbs: "up" | "down"): FeedbackRecord => ({
    schemaVersion: 1,
    id: `fb_${n}`,
    sessionId: SESSION,
    turnNumber: n,
    modality: "binary",
    rating: { thumbs },
    source: "cli",
    ts: `2026-07-01T00:00:0${n}.000Z`,
  });

  test("distilled samples promote as v1 and re-promote as v2", async () => {
    const turns = [1, 2, 3, 4].map((n) => turn(n, `question ${n}`, `answer ${n}`));
    const feedback = [rating(1, "up"), rating(2, "down"), rating(3, "up"), rating(4, "up")];
    const result = distill(turns, feedback, { minScore: 0.7 });
    expect(result.samples).toHaveLength(4);

    const registry = newRegistry();
    const rec = await registerDataset({
      registry,
      name: "ratings-golden",
      samples: result.samples,
    });
    expect(rec.version).toBe("v1");
    const total = rec.splits.train.length + rec.splits.dev.length + (rec.splits.test?.length ?? 0);
    expect(total).toBe(4);
    // The promoted version is immediately consumable via the shorthand —
    // minus the locked test rows (B16: bare refs select train+dev only).
    const resolved = await resolveRegistryRef(registry, { name: "ratings-golden" });
    expect(resolved.datasetName).toBe("ratings-golden@v1");
    expect(resolved.samples.map((s) => s.id).sort()).toEqual(
      [...rec.splits.train, ...rec.splits.dev].map((s) => s.id).sort(),
    );

    const rec2 = await registerDataset({
      registry,
      name: "ratings-golden",
      samples: result.samples,
    });
    expect(rec2.version).toBe("v2");
    // Same samples → same per-split assignment (determinism end to end).
    expect(rec2.splits.train.map((s) => s.id)).toEqual(rec.splits.train.map((s) => s.id));
    expect(rec2.sampleHashes).toEqual(rec.sampleHashes);
  });
});

describe("B18 — contamination canaries", () => {
  test("canarySample is deterministic (no wall clock) and taxonomy-tagged", () => {
    const a = canarySample("support", "v3");
    const b = canarySample("support", "v3");
    expect(a).toEqual(b);
    expect(SampleSchema.safeParse(a).success).toBe(true);
    expect(a.metadata?.["source"]).toBe("canary");
    expect(a.expected_output).toBeUndefined();
    expect(a.input).toContain(canaryPhrase("support", "v3"));
    // Distinct per version and per name.
    expect(canarySample("support", "v4").input).not.toBe(a.input);
    expect(canarySample("other", "v3").input).not.toBe(a.input);
  });

  test("registerDataset canary:true injects exactly ONE canary riding the deterministic split", async () => {
    const registry = newRegistry();
    const rec = await registerDataset({
      registry,
      name: "with-canary",
      samples: samples(9),
      canary: true,
    });
    const all = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])];
    expect(all.length).toBe(10);
    const canaries = all.filter((s) => s.metadata?.["source"] === "canary");
    expect(canaries.length).toBe(1);
    expect(canaries[0]?.input).toContain(canaryPhrase("with-canary", "v1"));
    // The phrase folds the AUTO-BUMPED version, so v2's canary differs.
    const rec2 = await registerDataset({
      registry,
      name: "with-canary",
      samples: samples(9),
      canary: true,
    });
    const all2 = [...rec2.splits.train, ...rec2.splits.dev, ...(rec2.splits.test ?? [])];
    const canary2 = all2.find((s) => s.metadata?.["source"] === "canary");
    expect(canary2?.input).toContain(canaryPhrase("with-canary", "v2"));
  });

  test("canary:true with --split lands the canary in that single split", async () => {
    const registry = newRegistry();
    const rec = await registerDataset({
      registry,
      name: "canary-split",
      samples: samples(2),
      split: "dev",
      canary: true,
    });
    expect(rec.splits.train.length).toBe(0);
    expect(rec.splits.dev.length).toBe(3);
    expect(rec.splits.dev.some((s) => s.metadata?.["source"] === "canary")).toBe(true);
  });

  test("without canary:true nothing is injected (byte-identical promotion)", async () => {
    const registry = newRegistry();
    const rec = await registerDataset({ registry, name: "plain", samples: samples(4) });
    const all = [...rec.splits.train, ...rec.splits.dev, ...(rec.splits.test ?? [])];
    expect(all.length).toBe(4);
    expect(all.some((s) => s.metadata?.["source"] === "canary")).toBe(false);
  });
});

describe("B22 — provenance taxonomy at promotion", () => {
  test("off-taxonomy metadata.source warns through the sink, listing offenders", async () => {
    const registry = newRegistry();
    const warnings: string[] = [];
    await registerDataset({
      registry,
      name: "tax",
      samples: [
        { id: "a", input: "1", metadata: { source: "synthesize" } },
        // B22 — legacy tool tag: mine now stamps "production_log", so a
        // raw "mine" value is off-taxonomy and warns like any other.
        { id: "b", input: "2", metadata: { source: "mine" } },
        { id: "c", input: "3" },
      ],
      warn: (line) => warnings.push(line),
    });
    expect(warnings.length).toBe(2);
    const synthesize = warnings.find((w) => w.includes('"synthesize"'));
    expect(synthesize).toContain("a");
    expect(synthesize).toContain("human_authored | production_log | synthetic");
    const mine = warnings.find((w) => w.includes('"mine"'));
    expect(mine).toContain("b");
  });

  test("taxonomy members and untagged samples promote silently", async () => {
    const registry = newRegistry();
    const warnings: string[] = [];
    await registerDataset({
      registry,
      name: "tax2",
      samples: [
        { id: "a", input: "1", metadata: { source: "production_log" } },
        { id: "b", input: "2" },
      ],
      warn: (line) => warnings.push(line),
    });
    expect(warnings).toEqual([]);
  });

  test("promoteVerifiedSynthetics retags ONLY golded synthetics", () => {
    const out = promoteVerifiedSynthetics([
      { id: "a", input: "1", expected_output: "g", metadata: { source: "synthetic", from: "x" } },
      { id: "b", input: "2", metadata: { source: "synthetic" } },
      { id: "c", input: "3", expected_output: "g", metadata: { source: "mine" } },
    ]);
    expect(out[0]?.metadata?.["source"]).toBe("synthetic_human_verified");
    expect(out[0]?.metadata?.["from"]).toBe("x"); // rest of metadata kept
    expect(out[1]?.metadata?.["source"]).toBe("synthetic");
    expect(out[2]?.metadata?.["source"]).toBe("mine");
  });

  test("distill stamps production_log + the rating channel as feedback_source", () => {
    const turns: SessionTurn[] = [
      {
        sessionId: "s1",
        turnNumber: 1,
        input: "question",
        output: "answer",
        toolNames: [],
      },
    ];
    const feedback: FeedbackRecord[] = [
      {
        sessionId: "s1",
        turnNumber: 1,
        rating: "up",
        source: "ui",
        ts: "2026-07-25T00:00:00.000Z",
      },
    ];
    const result = distill(turns, feedback, { minScore: 0.5 });
    expect(result.samples.length).toBe(1);
    expect(result.samples[0]?.metadata?.["source"]).toBe("production_log");
    expect(result.samples[0]?.metadata?.["feedback_source"]).toBe("ui");
  });
});
