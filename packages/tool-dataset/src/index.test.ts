import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
/**
 * The four tools, driven against a real workspace.
 *
 * Every test builds a throwaway directory under the OS temp dir, chdir's into
 * it (the containment root is `process.cwd()`), and removes it afterwards.
 * Nothing here reaches a network address and nothing writes into the
 * repository.
 *
 * The assertions are about WHAT HAPPENED ON DISK, not about what the result
 * says happened. A put that claims `moved: []` is checked by reading both
 * version records back and comparing the splits row by row; a dry run is
 * checked by listing the registry directory afterwards. The two are not the
 * same claim, and only the first one is worth making.
 */
import { canaryPhrase, canarySampleId } from "@crewhaus/dataset-ops";
import type { Sample } from "@crewhaus/eval-dataset";
import { DATASET_TOOLS, datasetInspect, datasetLint, datasetMine, datasetPut } from "./index";

const originalCwd = process.cwd();
const originalDatasetsDir = process.env["CREWHAUS_DATASETS_DIR"];
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-dataset-"));
  process.chdir(tmp);
  Reflect.deleteProperty(process.env, "CREWHAUS_DATASETS_DIR");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  // An unset var must be REMOVED, not set to the string "undefined".
  if (originalDatasetsDir === undefined)
    Reflect.deleteProperty(process.env, "CREWHAUS_DATASETS_DIR");
  else process.env["CREWHAUS_DATASETS_DIR"] = originalDatasetsDir;
});

// biome-ignore lint/suspicious/noExplicitAny: a tool returns JSON text; the tests read it as data
type Json = any;

async function call(tool: (typeof DATASET_TOOLS)[number], input: unknown): Promise<string> {
  return String(await tool.execute(input as never));
}

/** Drive a tool and parse its JSON result, failing loudly on a refusal. */
async function ok(tool: (typeof DATASET_TOOLS)[number], input: unknown): Promise<Json> {
  const out = await call(tool, input);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`expected JSON from ${tool.name}, got: ${out}`);
  }
}

const REGISTRY = ".crewhaus/datasets";

function recordPath(name: string, version: string): string {
  return path.join(tmp, REGISTRY, name, `${version}.json`);
}

function readRecordFile(name: string, version: string): Json {
  return JSON.parse(readFileSync(recordPath(name, version), "utf8"));
}

function versionFiles(name: string): string[] {
  const dir = path.join(tmp, REGISTRY, name);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** id → split, read off the record ON DISK. */
function diskAssignment(name: string, version: string): Map<string, string> {
  const record = readRecordFile(name, version);
  const out = new Map<string, string>();
  for (const split of ["train", "dev", "test"]) {
    for (const s of record.splits[split] ?? []) out.set(s.id, split);
  }
  return out;
}

const sample = (i: number, extra: Partial<Sample> = {}): Sample => ({
  id: `s${i}`,
  input: `question number ${i}`,
  ...extra,
});

const rows = (n: number): Sample[] => Array.from({ length: n }, (_, i) => sample(i));

function writeSession(id: string, lines: unknown[], dir = ".crewhaus/sessions"): void {
  mkdirSync(path.join(tmp, dir), { recursive: true });
  writeFileSync(
    path.join(tmp, dir, `${id}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

const userTurn = (text: string) => ({ kind: "user_message", payload: { content: text } });
const errorEvent = (message: string) => ({
  kind: "error",
  payload: { name: "TypeError", message },
});

// ---------------------------------------------------------------------------
// DatasetPut
// ---------------------------------------------------------------------------

describe("DatasetPut", () => {
  test("writes a first version whose splits partition the input", async () => {
    const result = await ok(datasetPut, { name: "qa", samples: rows(20) });
    expect(result.wrote).toBe(true);
    expect(result.version).toBe("v1");
    const record = readRecordFile("qa", "v1");
    const total =
      record.splits.train.length + record.splits.dev.length + (record.splits.test?.length ?? 0);
    expect(total).toBe(20);
    expect(result.splits).toEqual({
      train: record.splits.train.length,
      dev: record.splits.dev.length,
      test: record.splits.test.length,
    });
  });

  test("a re-put with added rows leaves every existing row in its split ON DISK", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(50) });
    const before = diskAssignment("qa", "v1");
    const result = await ok(datasetPut, {
      name: "qa",
      samples: [...rows(50), sample(50), sample(51), sample(52)],
    });
    const after = diskAssignment("qa", "v2");
    const drifted = [...before].filter(([id, split]) => after.get(id) !== split);
    console.log(
      `REPUT v2 moved=${result.stability.movedCount} carried=${result.stability.carriedForward} new=${result.stability.newlyAssigned} driftedOnDisk=${drifted.length}`,
    );
    expect(drifted).toEqual([]);
    expect(result.stability.moved).toEqual([]);
    expect(result.stability.carriedForward).toBe(50);
    expect(result.stability.newlyAssigned).toBe(3);
    expect(result.warnings).toEqual([]);
  });

  test("recompute mode reshuffles rows, and the result says which and why it matters", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(50) });
    const before = diskAssignment("qa", "v1");
    const result = await ok(datasetPut, {
      name: "qa",
      samples: [...rows(50), sample(50)],
      splitMode: "recompute",
    });
    const after = diskAssignment("qa", "v2");
    const drifted = [...before].filter(([id, split]) => after.get(id) !== split);
    console.log(`RECOMPUTE reported=${result.stability.movedCount} onDisk=${drifted.length}`);
    // The reported moves are the moves that happened, not an estimate.
    expect(result.stability.movedCount).toBe(drifted.length);
    expect(drifted.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toMatch(/baseline/i);
  });

  test("dryRun predicts the same version, splits and content hash, and writes nothing", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(20) });
    const before = versionFiles("qa");
    const dry = await ok(datasetPut, {
      name: "qa",
      samples: [...rows(20), sample(20)],
      dryRun: true,
    });
    expect(versionFiles("qa")).toEqual(before);
    expect(dry.wrote).toBe(false);
    const real = await ok(datasetPut, { name: "qa", samples: [...rows(20), sample(20)] });
    // A preview that resolves through a parallel path drifts from the real
    // one (tool-hostfs predicted a destination the real call never used), so
    // the prediction is compared field by field with what was written.
    expect({
      version: dry.version,
      splits: dry.splits,
      hash: dry.datasetHash,
      stability: dry.stability,
    }).toEqual({
      version: real.version,
      splits: real.splits,
      hash: real.datasetHash,
      stability: real.stability,
    });
    // ...and the hash it predicted is the hash of what the registry stored.
    const inspected = await ok(datasetInspect, { dataset: "qa@v2" });
    expect(inspected.hashes.overall).toBe(dry.datasetHash);
  });

  test("duplicate sample ids are refused, by the lint's own rule", async () => {
    const out = await call(datasetPut, {
      name: "qa",
      samples: [sample(1), { ...sample(1), input: "different" }],
    });
    expect(out).toContain("duplicate sample id");
    expect(versionFiles("qa")).toEqual([]);
  });

  test("a previous version that cannot be read refuses the write rather than guessing", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(10) });
    writeFileSync(recordPath("qa", "v1"), "{ this is not json");
    const out = await call(datasetPut, { name: "qa", samples: rows(12) });
    console.log(`TORN_PREVIOUS ${out.slice(0, 200)}`);
    // The REASON, not merely a failure: an assertion that only checks "no v2"
    // would also pass if the tool had crashed.
    expect(out).toMatch(/could not be read/i);
    expect(out).toMatch(/lineage/i);
    expect(versionFiles("qa")).toEqual(["v1.json"]);
  });

  test("basedOn names a version that does not exist — refused, with the versions that do", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(10) });
    const out = await call(datasetPut, { name: "qa", samples: rows(11), basedOn: "v9" });
    expect(out).toContain("v9");
    expect(out).toContain("v1");
    expect(versionFiles("qa")).toEqual(["v1.json"]);
  });

  test("the canary sample is written but its phrase is never echoed", async () => {
    const result = await ok(datasetPut, { name: "qa", samples: rows(10), canary: true });
    const raw = await call(datasetPut, { name: "qa2", samples: rows(10), canary: true });
    const phrase = canaryPhrase("qa2", "v1");
    expect(phrase.length).toBe(32);
    // A tool result IS prompt-side text. Echoing the tripwire into a model's
    // context is the contamination the tripwire exists to detect.
    expect(raw).not.toContain(phrase);
    // The id the caller is handed is the id of the sample ON DISK, and the
    // id dataset-ops derives — not a template re-spelled in this package.
    // The phrase is withheld, so a wrong id is a tripwire nobody can find.
    expect(result.canary.sampleId).toBe(canarySampleId("qa", "v1"));
    const written = readRecordFile("qa", "v1");
    const ids = [
      ...written.splits.train,
      ...written.splits.dev,
      ...(written.splits.test ?? []),
    ].map((s: Sample) => s.id);
    expect(ids).toContain(result.canary.sampleId);
    const record = readRecordFile("qa2", "v1");
    const all = [...record.splits.train, ...record.splits.dev, ...(record.splits.test ?? [])];
    expect(all.some((s: Sample) => s.input.includes(canaryPhrase("qa2", "v1")))).toBe(true);
  });

  test("redaction rewrites the stored text and flags the golds it rewrote", async () => {
    const result = await ok(datasetPut, {
      name: "qa",
      redact: true,
      samples: [
        { id: "a", input: "email me at alice@example.com", expected_output: "alice@example.com" },
        { id: "b", input: "plain question" },
      ],
    });
    const record = readRecordFile("qa", "v1");
    const stored = JSON.stringify(record.splits);
    expect(stored).not.toContain("alice@example.com");
    expect(stored).toContain("[REDACTED:email]");
    expect(result.redaction.samplesAltered).toBe(1);
    expect(result.redaction.goldsAltered).toEqual(["a"]);
    // A redacted gold can never be matched by a string grader, because the
    // agent's live output is not redacted. Said out loud.
    expect(result.warnings.join(" ")).toMatch(/gold/i);
  });

  test("PII hit counts are reported without ever echoing the match", async () => {
    const out = await call(datasetPut, {
      name: "qa",
      samples: [{ id: "a", input: "reach me on alice@example.com" }],
    });
    expect(out).not.toContain("alice@example.com");
    const result = JSON.parse(out);
    expect(result.pii.status).toBe("scanned");
    expect(result.pii.byKind.email).toBeGreaterThan(0);
  });

  test("a PII hit list longer than the cap says how many rows it is a prefix of", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `s${i}`,
      input: `reach me on user${i}@example.com`,
    }));
    const result = await ok(datasetPut, { name: "qa", samples: many });
    expect(result.pii.status).toBe("scanned");
    expect(result.pii.hitGroups).toBe(60);
    expect(result.pii.hits.length).toBe(50);
    // Without this the caller reads 50 rows and a totalHits of 60 and has to
    // guess which number the list is.
    expect(result.pii.hitsElided).toBe(10);
  });

  test("the registry's synthetic-never-gold invariant surfaces as a refusal", async () => {
    const out = await call(datasetPut, {
      name: "qa",
      samples: [{ id: "a", input: "x", expected_output: "y", metadata: { source: "synthetic" } }],
    });
    expect(out).toMatch(/synthetic/i);
    expect(versionFiles("qa")).toEqual([]);
  });

  test("dryRun refuses the synthetic-gold write the real call refuses, for the same reason", async () => {
    const synthetic = [
      { id: "a", input: "x", expected_output: "y", metadata: { source: "synthetic" } },
    ];
    // A preview is only worth reading if it predicts the real call. This one
    // used to plan a version, a split and a content hash for a write the
    // registry then threw on — the parallel-preview drift house rule 7 names.
    const dry = await call(datasetPut, { name: "qa", samples: synthetic, dryRun: true });
    const real = await call(datasetPut, { name: "qa", samples: synthetic });
    expect(dry).toBe(real);
    expect(dry).toMatch(/synthetic/i);
    expect(dry).toMatch(/synthetic_human_verified/);
    expect(() => JSON.parse(dry)).toThrow();
    expect(versionFiles("qa")).toEqual([]);
  });

  test("the synthetic refusal is exactly the registry's rule, not a wider one", async () => {
    // The detector asks dataset-ops' own retag helper which samples B22
    // rewrites rather than re-deriving the condition — so it has to be
    // pinned on both sides, or a future change to that helper becomes a tool
    // refusing writes the registry would have accepted.
    const goldless = await ok(datasetPut, {
      name: "qa",
      samples: [{ id: "a", input: "x", metadata: { source: "synthetic" } }],
    });
    expect(goldless.wrote).toBe(true);
    const verified = await ok(datasetPut, {
      name: "qa2",
      samples: [
        {
          id: "a",
          input: "x",
          expected_output: "y",
          metadata: { source: "synthetic_human_verified" },
        },
      ],
    });
    expect(verified.wrote).toBe(true);
  });

  test("off-taxonomy provenance is a warning, not a refusal — foreign datasets still import", async () => {
    const result = await ok(datasetPut, {
      name: "qa",
      samples: [{ id: "a", input: "x", metadata: { source: "scraped_from_somewhere" } }],
    });
    expect(result.wrote).toBe(true);
    expect(result.provenanceWarnings[0].source).toBe("scraped_from_somewhere");
  });

  test("a single-split put reports the rows it pulled across, on disk", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(20) });
    const before = diskAssignment("qa", "v1");
    const result = await ok(datasetPut, { name: "qa", samples: rows(20), split: "train" });
    const record = readRecordFile("qa", "v2");
    expect(record.splits.train.length).toBe(20);
    expect(result.stability.movedCount).toBe(
      [...before.values()].filter((s) => s !== "train").length,
    );
  });

  test("a held-out split is not deleted by a later spec that gives test 0%", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(20) });
    const heldOut = readRecordFile("qa", "v1").splits.test.map((s: Sample) => s.id);
    expect(heldOut.length).toBeGreaterThan(0);
    await ok(datasetPut, { name: "qa", samples: rows(20), splitSpec: "80/20" });
    const after = readRecordFile("qa", "v2");
    expect(after.splits.test.map((s: Sample) => s.id)).toEqual(heldOut);
  });

  test("an invalid split spec is refused with the grammar", async () => {
    const out = await call(datasetPut, { name: "qa", samples: rows(4), splitSpec: "70/40" });
    expect(out).toMatch(/sum to 100/i);
    expect(versionFiles("qa")).toEqual([]);
  });

  test("a dataset name the registry will not accept is refused before any write", async () => {
    const out = await call(datasetPut, { name: "../escape", samples: rows(2) });
    expect(out).toMatch(/rejected|invalid/i);
    expect(existsSync(path.join(tmp, REGISTRY))).toBe(false);
  });

  test("a samples file outside the workspace is refused", async () => {
    const out = await call(datasetPut, { name: "qa", path: "../outside.jsonl" });
    expect(out).toMatch(/escapes the workspace/i);
  });

  test("a URL as the samples path is treated as a path, never fetched", async () => {
    const out = await call(datasetPut, { name: "qa", path: "https://example.invalid/d.jsonl" });
    expect(out).toMatch(/does not exist|escapes|extension/i);
    expect(versionFiles("qa")).toEqual([]);
  });

  test("samples and path together, or neither, is a bad call", async () => {
    expect(await call(datasetPut, { name: "qa" })).toContain("not neither");
    expect(await call(datasetPut, { name: "qa", samples: rows(1), path: "d.jsonl" })).toContain(
      "not both",
    );
  });

  test("an empty sample set is refused", async () => {
    expect(await call(datasetPut, { name: "qa", samples: [] })).toMatch(/no samples/i);
  });

  test("a dataset file on disk is loaded through the runner's schema", async () => {
    writeFileSync(
      path.join(tmp, "d.jsonl"),
      `${rows(6)
        .map((s) => JSON.stringify(s))
        .join("\n")}\n`,
    );
    const result = await ok(datasetPut, { name: "qa", path: "d.jsonl" });
    expect(result.sampleCount).toBe(6);
  });

  test("no schema in this package can overwrite a version", () => {
    for (const tool of DATASET_TOOLS) {
      const shape = JSON.stringify(tool.inputSchema);
      for (const field of ["allowOverwrite", "force", "overwrite", "delete"]) {
        expect({ tool: tool.name, field, present: shape.includes(field) }).toEqual({
          tool: tool.name,
          field,
          present: false,
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// DatasetInspect
// ---------------------------------------------------------------------------

describe("DatasetInspect", () => {
  test("an absent registry is absent, not empty", async () => {
    const result = await ok(datasetInspect, {});
    expect(result.registryExists).toBe(false);
    expect(result.note).toMatch(/absent/i);
  });

  test("lists datasets with their versions, newest last", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(4) });
    await ok(datasetPut, { name: "qa", samples: rows(5) });
    await ok(datasetPut, { name: "other", samples: rows(4) });
    const result = await ok(datasetInspect, {});
    expect(result.datasets.map((d: Json) => d.name)).toEqual(["other", "qa"]);
    const qa = result.datasets.find((d: Json) => d.name === "qa");
    expect(qa.versions).toEqual(["v1", "v2"]);
    expect(qa.latest).toBe("v2");
  });

  test("reports split sizes, gold coverage and verified hashes", async () => {
    await ok(datasetPut, {
      name: "qa",
      samples: rows(10).map((s, i) => (i < 4 ? { ...s, expected_output: "yes" } : s)),
    });
    const result = await ok(datasetInspect, { dataset: "qa" });
    expect(result.version).toBe("v1");
    expect(result.resolvedFrom).toBe("latest");
    expect(result.golds).toBe(4);
    expect(result.hashes.status).toBe("verified");
    expect(result.hashes.overall).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a hand-edited sample makes the stored hashes MISMATCH, and names the row", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(10) });
    const record = readRecordFile("qa", "v1");
    record.splits.train[0].input = "tampered";
    writeFileSync(recordPath("qa", "v1"), JSON.stringify(record, null, 2));
    const result = await ok(datasetInspect, { dataset: "qa@v1" });
    console.log(`TAMPER ${JSON.stringify(result.hashes).slice(0, 220)}`);
    expect(result.hashes.status).toBe("mismatched");
    expect(result.hashes.mismatches[0].split).toBe("train");
    expect(result.hashes.mismatches[0].storedHash).not.toBe(result.hashes.mismatches[0].actualHash);
  });

  test("a record with samples but no stored hashes is UNAVAILABLE, not verified", async () => {
    mkdirSync(path.join(tmp, REGISTRY, "legacy"), { recursive: true });
    writeFileSync(
      path.join(tmp, REGISTRY, "legacy", "v1.json"),
      JSON.stringify({
        name: "legacy",
        version: "v1",
        splits: { train: [sample(1)], dev: [] },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const result = await ok(datasetInspect, { dataset: "legacy" });
    // An empty digest would let two different datasets compare equal. "I
    // cannot compute this" is the only honest answer.
    expect(result.hashes.status).toBe("unavailable");
    expect(result.hashes.overall).toBeUndefined();
    expect(result.hashes.reason).toMatch(/no stored sample hashes/i);
  });

  test("a torn record is unreadable, not absent, and the version still lists", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(4) });
    writeFileSync(recordPath("qa", "v1"), "{ nope");
    const result = await ok(datasetInspect, { dataset: "qa@v1" });
    expect(result.status).toBe("unreadable");
    expect(result.versions).toEqual(["v1"]);
    expect(result.reason).toMatch(/not valid JSON/i);
  });

  test("a #split suffix is refused rather than silently reporting every split", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(20) });
    // The ref grammar parses `#train`, and this tool answers about the whole
    // version — so a caller who writes it would read `sampleCount` as the
    // size of one split. Parsed and then ignored is the worst of the three.
    const out = await call(datasetInspect, { dataset: "qa@v1#train" });
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain("#train");
    expect(out).toMatch(/reports every split/i);
  });

  test("a dataset with no versions is absent with a reason", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(4) });
    const result = await ok(datasetInspect, { dataset: "nothing-here" });
    expect(result.status).toBe("absent");
    expect(result.reason).toMatch(/no versions/i);
  });

  test("test-split detail is withheld until it is asked for", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(20) });
    const guarded = await ok(datasetInspect, { dataset: "qa", includeSampleIds: true });
    expect(guarded.testSplit.detailWithheld).toBe(true);
    expect(guarded.splits.test.ids).toBeUndefined();
    expect(guarded.splits.test.count).toBeGreaterThan(0);
    const opened = await ok(datasetInspect, {
      dataset: "qa",
      includeSampleIds: true,
      allowTestSplit: true,
    });
    expect(opened.splits.test.ids.length).toBe(opened.splits.test.count);
  });

  test("PII in the holdout still counts, but arrives without the sample id", async () => {
    await ok(datasetPut, {
      name: "qa",
      samples: rows(20).map((s) => ({ ...s, input: `${s.input} call 555-123-4567` })),
    });
    const guarded = await ok(datasetInspect, { dataset: "qa" });
    expect(guarded.pii.totalHits).toBeGreaterThan(0);
    const testIds = new Set(
      readRecordFile("qa", "v1").splits.test.map((s: Sample) => s.id) as string[],
    );
    expect(testIds.size).toBeGreaterThan(0);
    for (const hit of guarded.pii.hits) {
      expect(testIds.has(hit.sampleId ?? "")).toBe(false);
    }
    // Non-vacuous: the holdout's hits ARE in the count, they just arrive
    // without an id. A filter that dropped them entirely would pass the loop
    // above and hide a leak.
    const idless = guarded.pii.hits.filter((h: Json) => h.sampleId === undefined);
    expect(idless.length).toBe(testIds.size);
  });

  test("turning the audit off reports SKIPPED rather than a clean scan", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(4) });
    const result = await ok(datasetInspect, { dataset: "qa", audit: false });
    expect(result.pii.status).toBe("skipped");
    expect(result.pii.totalHits).toBeUndefined();
  });

  test("a registry with more datasets than the listing cap says the list is a prefix", async () => {
    // Written directly rather than through 250 puts: the claim under test is
    // that the LISTING says it is partial, not that the writer is fast.
    for (let i = 0; i < 250; i++) {
      mkdirSync(path.join(tmp, REGISTRY, `ds${String(i).padStart(3, "0")}`), { recursive: true });
    }
    const result = await ok(datasetInspect, {});
    expect(result.datasetCount).toBe(250);
    expect(result.datasets.length).toBe(200);
    expect(result.truncated).toBe(true);
    // 250 directories created and 200 listed: cheap here, and a loaded
    // two-core CI box is not this machine, so it gets a budget.
  }, 20_000);

  test("provenance is summarized, and off-taxonomy values are called out", async () => {
    await ok(datasetPut, {
      name: "qa",
      samples: [
        { id: "a", input: "x", metadata: { source: "human_authored" } },
        { id: "b", input: "y", metadata: { source: "weird" } },
        { id: "c", input: "z" },
      ],
    });
    const result = await ok(datasetInspect, { dataset: "qa" });
    expect(result.sources).toEqual({ human_authored: 1, weird: 1, "(none)": 1 });
    expect(result.offTaxonomySources).toEqual([{ source: "weird", count: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// DatasetLint
// ---------------------------------------------------------------------------

describe("DatasetLint", () => {
  test("a clean dataset is clean, and says which rules it could not run", async () => {
    const result = await ok(datasetLint, { samples: rows(5) });
    expect(result.clean).toBe(true);
    expect(result.errorCount).toBe(0);
    const rules = result.rulesNotEvaluated.map((r: Json) => r.rule).sort();
    // "Clean" is only ever a statement about the rules that RAN.
    expect(rules).toEqual([
      "canary-leak",
      "cross-version-id-reuse",
      "expected-tools-no-tools",
      "grader-gold-mismatch",
    ]);
  });

  test("duplicate ids and empty golds are errors", async () => {
    const result = await ok(datasetLint, {
      samples: [
        sample(1),
        { ...sample(1), input: "other" },
        { id: "b", input: "x", expected_output: "  " },
      ],
    });
    const rules = result.findings.map((f: Json) => f.rule).sort();
    expect(rules).toContain("duplicate-id");
    expect(rules).toContain("empty-gold");
    expect(result.errorCount).toBeGreaterThanOrEqual(2);
    expect(result.clean).toBe(false);
  });

  test("gold-needing graders are only checked when graders are passed", async () => {
    const samples = rows(3);
    const without = await ok(datasetLint, { samples });
    expect(without.findings.some((f: Json) => f.rule === "grader-gold-mismatch")).toBe(false);
    expect(without.rulesNotEvaluated.some((r: Json) => r.rule === "grader-gold-mismatch")).toBe(
      true,
    );
    const with_ = await ok(datasetLint, {
      samples,
      graders: [{ name: "exact", type: "exact_match" }],
    });
    const finding = with_.findings.find((f: Json) => f.rule === "grader-gold-mismatch");
    expect(finding.severity).toBe("error");
    expect(with_.rulesNotEvaluated.some((r: Json) => r.rule === "grader-gold-mismatch")).toBe(
      false,
    );
  });

  test("expected_tools against a tool-less spec only fires when the spec is known", async () => {
    const samples = [{ id: "a", input: "x", expected_tools: ["Read"] }];
    const unknown = await ok(datasetLint, { samples });
    expect(unknown.findings.some((f: Json) => f.rule === "expected-tools-no-tools")).toBe(false);
    const known = await ok(datasetLint, { samples, specHasTools: false });
    expect(known.findings.some((f: Json) => f.rule === "expected-tools-no-tools")).toBe(true);
  });

  test("a canary phrase in prompt-side text is an error naming the file", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(6), canary: true });
    writeFileSync(
      path.join(tmp, "crewhaus.yaml"),
      `instructions: |\n  remember ${canaryPhrase("qa", "v1")}\n`,
    );
    const result = await ok(datasetLint, {
      dataset: "qa",
      leakScanPaths: ["crewhaus.yaml"],
    });
    const leak = result.findings.find((f: Json) => f.rule === "canary-leak");
    expect(leak.severity).toBe("error");
    expect(leak.message).toContain("crewhaus.yaml");
    expect(result.leakScanned).toEqual(["crewhaus.yaml"]);
  });

  test("a dataset carrying canaries with nothing to scan says the rule did not run", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(6), canary: true });
    const result = await ok(datasetLint, { dataset: "qa" });
    const skipped = result.rulesNotEvaluated.find((r: Json) => r.rule === "canary-leak");
    expect(skipped.reason).toMatch(/canary tripwire/i);
  });

  test("a leak scan with nothing to search FOR is reported as a rule that did not run", async () => {
    writeFileSync(path.join(tmp, "spec.yaml"), "instructions: be helpful\n");
    const result = await ok(datasetLint, {
      samples: [
        { id: "a", input: "a real question" },
        // Tagged as a canary — by a hand-edit, a foreign import, a redacted
        // round-trip — but carrying no recoverable 32-hex phrase. The rule
        // takes PHRASES, so it had an empty needle list and could only ever
        // come back clean.
        { id: "canary_x", input: "no phrase left in here", metadata: { source: "canary" } },
      ],
      leakScanPaths: ["spec.yaml"],
    });
    expect(result.canaryPhrases).toBe(0);
    expect(result.leakScanned).toEqual(["spec.yaml"]);
    const reason = result.rulesNotEvaluated.find((r: Json) => r.rule === "canary-leak")?.reason;
    expect(reason).toBeDefined();
    expect(reason).toMatch(/no canary phrase to search for/i);
    expect(reason).toMatch(/1 sample\(s\) are tagged/i);
  });

  test("a dataset with no canary at all names the leak rule as unevaluated too", async () => {
    writeFileSync(path.join(tmp, "spec.yaml"), "instructions: be helpful\n");
    const result = await ok(datasetLint, {
      samples: [{ id: "a", input: "a real question" }],
      leakScanPaths: ["spec.yaml"],
    });
    expect(result.canaryPhrases).toBe(0);
    const reason = result.rulesNotEvaluated.find((r: Json) => r.rule === "canary-leak")?.reason;
    expect(reason).toMatch(/no canary tripwire to search for/i);
  });

  test("a leak-scan path outside the workspace is refused and listed, not ignored", async () => {
    await ok(datasetPut, { name: "qa", samples: rows(4) });
    const result = await ok(datasetLint, { dataset: "qa", leakScanPaths: ["../outside.yaml"] });
    expect(result.leakScanSkipped.join(" ")).toMatch(/escapes the workspace/i);
    expect(result.leakScanned).toEqual([]);
  });

  test("an id reused across versions with different content is flagged", async () => {
    await ok(datasetPut, { name: "qa", samples: [sample(1), sample(2), sample(3)] });
    await ok(datasetPut, {
      name: "qa",
      samples: [{ ...sample(1), input: "a completely different question" }, sample(2), sample(3)],
    });
    const result = await ok(datasetLint, { dataset: "qa@v2" });
    const reuse = result.findings.find((f: Json) => f.rule === "cross-version-id-reuse");
    expect(reuse.ids).toContain("s1");
    expect(reuse.severity).toBe("warning");
  });

  test("a dataset too large for the all-pairs scan reports the scan as NOT PERFORMED", async () => {
    // The near-duplicate rule gives up above its own comparison cap. A tool
    // that folded that into "no findings" would report a 3000-row dataset
    // with duplicated content as clean.
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: `s${i}`, input: `q ${i}` }));
    const result = await ok(datasetLint, { samples: many });
    console.log(`BIG_SCAN ${JSON.stringify(result.nearDuplicateScan)}`);
    expect(result.nearDuplicateScan.performed).toBe(false);
    expect(result.nearDuplicateScan.reason).toMatch(/comparisons/i);
    expect(result.findings.some((f: Json) => f.rule === "near-duplicate-input")).toBe(false);
    expect(result.rulesNotEvaluated.some((r: Json) => r.rule === "near-duplicate-input")).toBe(
      true,
    );
  }, 30_000); // samples, so it gets a budget rather than the 5s default. // CI is a loaded two-core box on an older bun; this builds and lints 3000

  test("near-duplicate inputs are found when the scan does run", async () => {
    const result = await ok(datasetLint, {
      samples: [
        { id: "a", input: "the webhook returns a 502 when the payload is large" },
        { id: "b", input: "the webhook returns a 502 when the payload is large indeed" },
      ],
    });
    expect(result.nearDuplicateScan.performed).toBe(true);
    expect(result.findings.some((f: Json) => f.rule === "near-duplicate-input")).toBe(true);
  });

  test("exactly one source is required", async () => {
    expect(await call(datasetLint, {})).toContain("exactly one");
    expect(await call(datasetLint, { samples: rows(1), path: "d.jsonl" })).toContain("exactly one");
  });

  test("a registry dataset that does not exist is refused by name", async () => {
    const out = await call(datasetLint, { dataset: "ghost" });
    expect(out).toMatch(/no versions/i);
  });
});

// ---------------------------------------------------------------------------
// DatasetMine
// ---------------------------------------------------------------------------

describe("DatasetMine", () => {
  test("an error event becomes a candidate carrying its provenance", async () => {
    writeSession("sess-1", [
      userTurn("why does the invoice total not match"),
      errorEvent("TypeError: cannot read properties of undefined"),
    ]);
    const result = await ok(datasetMine, {});
    expect(result.candidateCount).toBe(1);
    const candidate = result.candidates[0];
    expect(candidate.signal).toBe("error");
    expect(candidate.sessionId).toBe("sess-1");
    expect(candidate.sample.metadata.source).toBe("production_log");
    expect(candidate.sample.metadata.status).toBe("quarantine");
    expect(candidate.sample.input).toBe("why does the invoice total not match");
  });

  test("it writes nothing — the registry is untouched", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    await ok(datasetMine, {});
    expect(existsSync(path.join(tmp, REGISTRY))).toBe(false);
  });

  test("a missing trace sidecar makes the in-loop judge signal UNAVAILABLE, not silent", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    const result = await ok(datasetMine, {});
    const signal = result.signals["eval-fail"];
    console.log(`SIDECAR ${JSON.stringify(signal)}`);
    expect(signal.available).toBe(false);
    expect(signal.reason).toMatch(/CREWHAUS_WATCHME/);
    expect(signal.sidecarsPresent).toBe(0);
  });

  test("a sidecar present makes the signal available", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    writeFileSync(
      path.join(tmp, ".crewhaus", "sessions", "sess-1.events.jsonl"),
      `${JSON.stringify({ kind: "note" })}\n`,
    );
    const result = await ok(datasetMine, {});
    expect(result.signals["eval-fail"].available).toBe(true);
    // ...and the sidecar was not itself mined as a session.
    expect(result.sessionsScanned).toBe(1);
    expect(result.sessionsAvailable).toBe(1);
  });

  test("a sidecar that exists and cannot be read is not counted as never written", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    // A directory where the sidecar should be: present, unreadable, and NOT
    // the "CREWHAUS_WATCHME was never set" story.
    mkdirSync(path.join(tmp, ".crewhaus", "sessions", "sess-1.events.jsonl"), { recursive: true });
    const result = await ok(datasetMine, {});
    expect(result.sessionsSkipped.map((s: Json) => s.reason).join(" ")).toMatch(/trace sidecar/i);
    expect(result.signals["eval-fail"].available).toBe(false);
    // The session itself was still mined.
    expect(result.candidateCount).toBe(1);
  });

  test("an absent audit log makes the egress signal unavailable, not 'no blocks'", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    const result = await ok(datasetMine, {});
    expect(result.signals["egress-block"].available).toBe(false);
    expect(result.signals["egress-block"].reason).toMatch(/does not exist|unreadable/i);
  });

  test("an audit log with a block reports it as a block, not as a sample", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    mkdirSync(path.join(tmp, ".crewhaus", "audit"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".crewhaus", "audit", "audit.jsonl"),
      `${JSON.stringify({ kind: "egress_decision", payload: { verdict: "block", sinkId: "webhook", sessionId: "sess-1" } })}\n`,
    );
    const result = await ok(datasetMine, {});
    const signal = result.signals["egress-block"];
    expect(signal.available).toBe(true);
    expect(signal.blocks[0].reason).toContain("webhook");
    // A sample whose input is an error string teaches nothing, so the block
    // is reported rather than invented into a candidate.
    expect(result.candidates.every((c: Json) => c.signal !== "egress-block")).toBe(true);
  });

  test("an audit log nobody could open is NOT an audit log with no blocks in it", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    // A `.jsonl` that is a DIRECTORY reproduces the unreadable-file path on
    // every host and under every uid — `chmod 000` does not, because a root
    // CI container reads it anyway and the test would quietly stop testing.
    mkdirSync(path.join(tmp, ".crewhaus", "audit", "audit.jsonl"), { recursive: true });
    const result = await ok(datasetMine, {});
    const signal = result.signals["egress-block"];
    // The directory EXISTS, so the old code reported available: true with an
    // empty block list — a read failure rendered as a clean bill of health.
    expect(signal.available).toBe(false);
    expect(signal.reason).toMatch(/failed to open/i);
    expect(signal.reason).toMatch(/NOT an absence of egress blocks/i);
    expect(signal.filesSkipped.join(" ")).toContain("audit.jsonl");
    expect(signal.blocks).toBeUndefined();
  });

  test("an audit directory with no .jsonl in it says so rather than reporting zero blocks", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    mkdirSync(path.join(tmp, ".crewhaus", "audit"), { recursive: true });
    const signal = (await ok(datasetMine, {})).signals["egress-block"];
    expect(signal.available).toBe(false);
    expect(signal.reason).toMatch(/no \.jsonl audit file/i);
  });

  test("a partly readable audit log reports its blocks AND that they are partial", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    mkdirSync(path.join(tmp, ".crewhaus", "audit"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".crewhaus", "audit", "a.jsonl"),
      `${JSON.stringify({ kind: "egress_decision", payload: { verdict: "block", sinkId: "webhook" } })}\n`,
    );
    mkdirSync(path.join(tmp, ".crewhaus", "audit", "b.jsonl"), { recursive: true });
    const signal = (await ok(datasetMine, {})).signals["egress-block"];
    expect(signal.available).toBe(true);
    expect(signal.partial).toBe(true);
    expect(signal.blockCount).toBe(1);
    expect(signal.filesSkipped.join(" ")).toContain("b.jsonl");
  });

  test("more blocks than the listing cap reports the count, not just the prefix", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    mkdirSync(path.join(tmp, ".crewhaus", "audit"), { recursive: true });
    const lines = Array.from({ length: 120 }, (_, i) =>
      JSON.stringify({
        kind: "egress_decision",
        payload: { verdict: "block", sinkId: `sink${i}` },
      }),
    ).join("\n");
    writeFileSync(path.join(tmp, ".crewhaus", "audit", "a.jsonl"), `${lines}\n`);
    const signal = (await ok(datasetMine, {})).signals["egress-block"];
    expect(signal.blockCount).toBe(120);
    expect(signal.blocks.length).toBe(50);
    expect(signal.blocksElided).toBe(70);
  });

  test("malformed transcript lines are counted, not dropped in silence", async () => {
    mkdirSync(path.join(tmp, ".crewhaus", "sessions"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".crewhaus", "sessions", "sess-1.jsonl"),
      `${JSON.stringify(userTurn("q"))}\nnot json at all\n${JSON.stringify(errorEvent("boom"))}\n`,
    );
    const result = await ok(datasetMine, {});
    expect(result.malformedLines).toBe(1);
    expect(result.candidateCount).toBe(1);
  });

  test("candidates already in the registry are dropped, naming the version they matched", async () => {
    writeSession("sess-1", [userTurn("why does the invoice total not match"), errorEvent("boom")]);
    const first = await ok(datasetMine, {});
    await ok(datasetPut, { name: "hardcases", samples: [first.candidates[0].sample] });
    const second = await ok(datasetMine, { dedupeAgainst: "hardcases" });
    console.log(`DEDUPE ${JSON.stringify(second.dedupe).slice(0, 300)}`);
    expect(second.candidateCount).toBe(0);
    expect(second.dedupe.performed).toBe(true);
    expect(second.dedupe.dropped["duplicate-id"]).toBe(1);
    expect(second.dedupe.examples[0].matchedVersion).toBe("v1");
  });

  test("a dedupe against a dataset that is not there is NOT a dedupe", async () => {
    writeSession("sess-1", [userTurn("why does the invoice total not match"), errorEvent("boom")]);
    // A typo in the name, the wrong registryDir, a registry never written:
    // all three list zero versions, and an empty corpus says "new" about
    // every candidate. Reported as a dedupe that ran, that is a clean bill
    // of health handed out by a misspelling.
    const result = await ok(datasetMine, { dedupeAgainst: "hardcasez" });
    expect(result.dedupe.performed).toBe(false);
    expect(result.dedupe.reason).toMatch(/no versions/i);
    expect(result.dedupe.reason).toMatch(/UNCHECKED, not new/);
    expect(result.dedupe.dropped).toBeUndefined();
    expect(result.candidateCount).toBe(1);
  });

  test("a dedupe target whose every version is torn is reported as not performed", async () => {
    await ok(datasetPut, { name: "hardcases", samples: [sample(1)] });
    writeFileSync(recordPath("hardcases", "v1"), "{ not json");
    writeSession("sess-1", [userTurn("why does the invoice total not match"), errorEvent("boom")]);
    const result = await ok(datasetMine, { dedupeAgainst: "hardcases" });
    expect(result.dedupe.performed).toBe(false);
    expect(result.dedupe.versionsSkipped.join(" ")).toContain("v1");
    expect(result.dedupe.reason).toMatch(/none of the 1 version\(s\).*could be read/i);
    expect(result.dedupe.reason).toMatch(/UNCHECKED, not new/);
  });

  test("without a dedupe target the result says the question was not asked", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    const result = await ok(datasetMine, {});
    expect(result.dedupe.performed).toBe(false);
    expect(result.dedupe.reason).toMatch(/already be in the registry/i);
  });

  test("a near-duplicate of an existing sample is dropped, and the parameters are reported", async () => {
    writeSession("sess-1", [
      userTurn("the deployment webhook returns a 502 when the payload is too large"),
      errorEvent("boom"),
    ]);
    await ok(datasetPut, {
      name: "hardcases",
      samples: [
        {
          id: "existing",
          input: "the deployment webhook returns a 502 when the payload is far too large",
        },
      ],
    });
    const result = await ok(datasetMine, {
      dedupeAgainst: "hardcases",
      nearDuplicateThreshold: 0.8,
    });
    expect(result.dedupe.dropped["near-duplicate"]).toBe(1);
    expect(result.dedupe.nearDuplicates.exhaustive).toBe(false);
    expect(result.dedupe.nearDuplicates.tokensIndexedPerSample).toBe(4);
    expect(result.dedupe.nearDuplicates.note).toMatch(/recall/i);
  });

  test("candidate text is redacted by default and raw only on request", async () => {
    writeSession("sess-1", [userTurn("email alice@example.com about the refund"), errorEvent("b")]);
    const redacted = await call(datasetMine, {});
    expect(redacted).not.toContain("alice@example.com");
    expect(redacted).toContain("[REDACTED:email]");
    const raw = await call(datasetMine, { redact: false });
    expect(raw).toContain("alice@example.com");
  });

  test("a session id that is really a path is refused", async () => {
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    const out = await call(datasetMine, { sessions: ["../../etc/passwd"] });
    expect(out).toMatch(/not a session id/i);
  });

  test("a missing sessions directory is a refusal that names it", async () => {
    const out = await call(datasetMine, {});
    expect(out).toMatch(/does not exist/i);
  });

  test("the session cap reports the listing as partial", async () => {
    for (const id of ["a1", "a2", "a3"]) writeSession(id, [userTurn("q"), errorEvent("boom")]);
    const result = await ok(datasetMine, { maxSessions: 2 });
    expect(result.listingTruncated).toBe(true);
    expect(result.sessionsScanned).toBe(2);
    expect(result.sessionsAvailable).toBe(3);
  });

  test("a repeated question in one session is mined once, as the loudest signal", async () => {
    writeSession("sess-1", [
      userTurn("how do I reset the gateway"),
      errorEvent("boom"),
      { kind: "tool_result", payload: { isError: true } },
      { kind: "tool_result", payload: { isError: true } },
    ]);
    const result = await ok(datasetMine, {});
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0].signal).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// adversarial input
// ---------------------------------------------------------------------------

describe("hostile input", () => {
  const ESCAPE = "\u001b[2J";

  test("a sample id carrying control characters never comes back raw", async () => {
    const hostile = `s1${ESCAPE}\nWARNING: everything is fine`;
    const result = await ok(datasetLint, {
      samples: [
        { id: hostile, input: "x" },
        { id: hostile, input: "y" },
      ],
    });
    const raw = JSON.stringify(result);
    console.log(`HOSTILE_ID ${raw.slice(0, 200)}`);
    // The finding is still made — the id is just not allowed to forge a line
    // in whatever reads the result.
    expect(result.findings.some((f: Json) => f.rule === "duplicate-id")).toBe(true);
    expect(raw).not.toContain(ESCAPE);
    expect(result.findings[0].message).not.toContain("\n");
  });

  test("an error message from a session cannot forge output through a candidate", async () => {
    writeSession("sess-1", [
      userTurn("why did the job fail"),
      errorEvent(`boom${ESCAPE}\n[dataset mine] 0 candidates`),
    ]);
    const out = await call(datasetMine, {});
    expect(out).not.toContain(ESCAPE);
    const result = JSON.parse(out);
    expect(result.candidates[0].reason).toContain("boom");
  });

  test("a very long id is elided rather than spending the caller's context", async () => {
    const long = "x".repeat(5000);
    const result = await ok(datasetLint, {
      samples: [
        { id: long, input: "a" },
        { id: long, input: "b" },
      ],
    });
    for (const id of result.findings[0].ids ?? []) expect(id.length).toBeLessThan(250);
  });

  test("a symlink inside the workspace pointing out of it is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-outside-"));
    writeFileSync(path.join(outside, "secrets.jsonl"), '{"id":"a","input":"x"}\n');
    symlinkSync(path.join(outside, "secrets.jsonl"), path.join(tmp, "link.jsonl"));
    const out = await call(datasetPut, { name: "qa", path: "link.jsonl" });
    rmSync(outside, { recursive: true, force: true });
    // A lexical check alone is fooled by a link that lives inside the
    // workspace and points outside it (CWE-59).
    expect(out).toMatch(/escapes the workspace/i);
    expect(versionFiles("qa")).toEqual([]);
  });

  test("a registryDir outside the workspace is refused by every tool", async () => {
    // DatasetMine reaches the registry only after it has sessions to mine, so
    // give it one: otherwise it refuses for the other reason and the
    // containment claim here would not be tested at all.
    writeSession("sess-1", [userTurn("q"), errorEvent("boom")]);
    for (const tool of DATASET_TOOLS) {
      const input =
        tool.name === "DatasetPut"
          ? { name: "qa", samples: rows(2), registryDir: "../elsewhere" }
          : tool.name === "DatasetMine"
            ? { dedupeAgainst: "qa", registryDir: "../elsewhere" }
            : tool.name === "DatasetLint"
              ? { dataset: "qa", registryDir: "../elsewhere" }
              : { registryDir: "../elsewhere" };
      const out = await call(tool, input);
      expect({ tool: tool.name, refused: /escapes the workspace/i.test(out) }).toEqual({
        tool: tool.name,
        refused: true,
      });
    }
  });

  test("a registry name that would traverse directories cannot create one", async () => {
    for (const name of ["../../etc/passwd", "..", "a/b", ".hidden"]) {
      const out = await call(datasetPut, { name, samples: rows(2) });
      expect({ name, refused: /rejected|invalid/i.test(out) }).toEqual({ name, refused: true });
    }
    expect(existsSync(path.join(tmp, REGISTRY))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

describe("tool declarations", () => {
  test("the readers are read-only and the writer is the only destructive one", () => {
    const flags = DATASET_TOOLS.map((t) => `${t.name}:${t.readOnly}/${t.destructive}`).sort();
    expect(flags).toEqual([
      "DatasetInspect:true/false",
      "DatasetLint:true/false",
      "DatasetMine:true/false",
      "DatasetPut:false/true",
    ]);
  });

  test("nothing here crosses a process or network boundary", () => {
    for (const tool of DATASET_TOOLS) {
      expect({ name: tool.name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        name: tool.name,
        scope: "internal",
        io: undefined,
      });
    }
  });

  test("every tool name is distinct and conventionally spelled", () => {
    const names = DATASET_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });
});
