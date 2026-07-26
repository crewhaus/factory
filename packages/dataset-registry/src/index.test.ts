/**
 * Section 29 — `dataset-registry` tests:
 *  - T1 file backend round-trip
 *  - T8 split-leak prevention
 *  - T9 hash-stability
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  DatasetRegistryError,
  appendReleaseEntry,
  compareVersions,
  createFileBackedRegistry,
  latestVersion,
  verifySplitHashes,
} from "./index";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "dataset-registry-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const sample = (id: string, input: string): Sample => ({ id, input });

async function collect(it: AsyncIterable<Sample>): Promise<Sample[]> {
  const out: Sample[] = [];
  for await (const s of it) out.push(s);
  return out;
}

describe("dataset-registry — T1 file backend", () => {
  test("put + get round-trip per split", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const rec = await reg.put({
      name: "smoke",
      version: "v1",
      splits: {
        train: [sample("t1", "a"), sample("t2", "b")],
        dev: [sample("d1", "c")],
        test: [sample("test1", "d")],
      },
    });
    expect(rec.sampleHashes.train).toBeDefined();
    expect(rec.sampleHashes.dev?.length).toBe(1);
    expect(rec.sampleHashes.test?.length).toBe(1);
    const train = await collect(reg.get("smoke", "v1", "train"));
    expect(train.length).toBe(2);
    const dev = await collect(reg.get("smoke", "v1", "dev"));
    expect(dev.length).toBe(1);
  });

  test("list returns versions", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({
      name: "x",
      version: "v1",
      splits: { train: [sample("a", "x")], dev: [] },
    });
    await reg.put({
      name: "x",
      version: "v2",
      splits: { train: [sample("a", "x")], dev: [] },
    });
    expect(await reg.list("x")).toEqual(["v1", "v2"]);
  });

  test("listDatasets returns names", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({ name: "a", version: "v1", splits: { train: [], dev: [] } });
    await reg.put({ name: "b", version: "v1", splits: { train: [], dev: [] } });
    const ds = [...(await reg.listDatasets())].sort();
    expect(ds).toEqual(["a", "b"]);
  });

  test("missing dataset throws", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(collect(reg.get("missing", "v1", "train"))).rejects.toBeInstanceOf(DatasetRegistryError);
  });

  test("rejects malformed names + versions", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(
      reg.put({ name: "../etc/passwd", version: "v1", splits: { train: [], dev: [] } }),
    ).rejects.toBeInstanceOf(DatasetRegistryError);
  });
});

describe("dataset-registry — T8 split-leak prevention", () => {
  test("test split refuses access without explicit allowTestSplit", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({
      name: "x",
      version: "v1",
      splits: {
        train: [sample("t", "a")],
        dev: [sample("d", "b")],
        test: [sample("test", "c")],
      },
    });
    expect(collect(reg.get("x", "v1", "test"))).rejects.toBeInstanceOf(DatasetRegistryError);
    const ok = await collect(reg.get("x", "v1", "test", { allowTestSplit: true }));
    expect(ok.length).toBe(1);
  });

  test("requesting a split that doesn't exist throws", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({
      name: "x",
      version: "v1",
      splits: { train: [sample("t", "a")], dev: [] },
      // no test split
    });
    expect(collect(reg.get("x", "v1", "test", { allowTestSplit: true }))).rejects.toBeInstanceOf(
      DatasetRegistryError,
    );
  });
});

describe("dataset-registry — T9 hash-stability", () => {
  test("same content → same sample hashes across runs", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const samples = [sample("a", "hello"), sample("b", "world")];
    const r1 = await reg.put({ name: "x", version: "v1", splits: { train: samples, dev: [] } });
    rmSync(tmpRoot, { recursive: true, force: true });
    const reg2 = createFileBackedRegistry({ rootDir: tmpRoot });
    const r2 = await reg2.put({ name: "x", version: "v1", splits: { train: samples, dev: [] } });
    expect(r1.sampleHashes.train).toEqual(r2.sampleHashes.train);
  });

  test("different content → different sample hashes", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const a = await reg.put({
      name: "x",
      version: "v1",
      splits: { train: [sample("a", "hello")], dev: [] },
    });
    const b = await reg.put({
      name: "x",
      version: "v2",
      splits: { train: [sample("a", "world")], dev: [] },
    });
    expect(a.sampleHashes.train).not.toEqual(b.sampleHashes.train);
    // 16 hex chars (sha256 truncated).
    expect(a.sampleHashes.train?.[0]).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("dataset-registry — getRecord", () => {
  test("returns the full persisted record including hashes + createdAt", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const written = await reg.put({
      name: "rec",
      version: "v1",
      splits: {
        train: [sample("t1", "a")],
        dev: [sample("d1", "b")],
        test: [sample("x1", "c")],
      },
    });
    const got = await reg.getRecord("rec", "v1");
    expect(got.name).toBe("rec");
    expect(got.version).toBe("v1");
    expect(got.createdAt).toBe(written.createdAt);
    expect(got.sampleHashes).toEqual(written.sampleHashes);
    expect(got.splits.train.length).toBe(1);
    expect(got.splits.test?.length).toBe(1);
  });

  test("throws DatasetRegistryError when the record is missing", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(reg.getRecord("nope", "v9")).rejects.toBeInstanceOf(DatasetRegistryError);
  });

  test("validates name + version before touching the filesystem", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(reg.getRecord("../../etc", "v1")).rejects.toBeInstanceOf(DatasetRegistryError);
    expect(reg.getRecord("ok", "..")).rejects.toBeInstanceOf(DatasetRegistryError);
  });
});

describe("dataset-registry — get iteration", () => {
  test("yields every sample in the test split when unlocked (drives the yield path)", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({
      name: "iter",
      version: "v1",
      splits: {
        train: [sample("t1", "a"), sample("t2", "b"), sample("t3", "c")],
        dev: [sample("d1", "d")],
        test: [sample("x1", "e"), sample("x2", "f")],
      },
    });
    const test = await collect(reg.get("iter", "v1", "test", { allowTestSplit: true }));
    expect(test.map((s) => s.id)).toEqual(["x1", "x2"]);
    const train = await collect(reg.get("iter", "v1", "train"));
    expect(train.map((s) => s.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("yields nothing for an empty (but present) split", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({
      name: "empty",
      version: "v1",
      splits: { train: [sample("t", "a")], dev: [] },
    });
    expect(await collect(reg.get("empty", "v1", "dev"))).toEqual([]);
  });

  test("split-leak guard fires before the file is even read", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    // No dataset on disk at all: if the guard short-circuits first we still get
    // the lock message rather than a not-found message.
    expect(collect(reg.get("never-written", "v1", "test"))).rejects.toThrow(/test split locked/);
  });
});

describe("dataset-registry — list / listDatasets edge cases", () => {
  test("list returns [] for a name with no directory yet", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(await reg.list("does-not-exist")).toEqual([]);
  });

  test("list ignores non-json entries in the dataset dir", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({ name: "mixed", version: "v1", splits: { train: [], dev: [] } });
    // Drop a non-json sibling that must be filtered out.
    writeFileSync(join(tmpRoot, "mixed", "README.txt"), "ignore me");
    expect(await reg.list("mixed")).toEqual(["v1"]);
  });

  test("listDatasets returns [] when the root dir does not exist", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "missing-root") });
    expect(await reg.listDatasets()).toEqual([]);
  });

  test("listDatasets hides dot- and underscore-prefixed entries", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({ name: "visible", version: "v1", splits: { train: [], dev: [] } });
    mkdirSync(join(tmpRoot, ".hidden"), { recursive: true });
    mkdirSync(join(tmpRoot, "_internal"), { recursive: true });
    expect([...(await reg.listDatasets())].sort()).toEqual(["visible"]);
  });
});

describe("dataset-registry — security & hardening", () => {
  test("DatasetRegistryError is a CrewhausError with code 'config'", () => {
    const err = new DatasetRegistryError("boom");
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.name).toBe("DatasetRegistryError");
    expect(err.code).toBe("config");
  });

  test("DatasetRegistryError preserves a cause via the error chain", () => {
    const cause = new Error("root cause");
    const err = new DatasetRegistryError("wrapped", cause);
    expect(err.cause).toBe(cause);
    expect(err.toJSON().cause).toEqual({ name: "Error", message: "root cause" });
  });

  test("rejects path-traversal in the dataset name on every entry point", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    for (const bad of ["../escape", "..", "a/b", "a\\b", "", ".dot-leading"]) {
      expect(
        reg.put({ name: bad, version: "v1", splits: { train: [], dev: [] } }),
      ).rejects.toBeInstanceOf(DatasetRegistryError);
    }
  });

  test("rejects path-traversal + separators in the version", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    for (const bad of ["..", "../x", "a/b", "a\\b", "", ".leading"]) {
      expect(
        reg.put({ name: "ok", version: bad, splits: { train: [], dev: [] } }),
      ).rejects.toBeInstanceOf(DatasetRegistryError);
    }
  });

  test("accepts names/versions with internal dots, dashes, underscores", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const rec = await reg.put({
      name: "my-data_set.v2",
      version: "1.0.0-rc_1",
      splits: { train: [sample("a", "x")], dev: [] },
    });
    expect(rec.name).toBe("my-data_set.v2");
    expect(await reg.list("my-data_set.v2")).toEqual(["1.0.0-rc_1"]);
  });

  test("does not escape the root: a traversal-shaped path never lands outside rootDir", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const outside = join(tmpRoot, "..", "escaped.json");
    // Sanity: the guard rejects the attempt entirely, and nothing is written outside root.
    expect(
      reg.put({ name: "../escaped", version: "v1", splits: { train: [], dev: [] } }),
    ).rejects.toBeInstanceOf(DatasetRegistryError);
    expect(existsSync(outside)).toBe(false);
  });

  test("persists dataset files with owner-only (0600) permissions", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({ name: "perm", version: "v1", splits: { train: [sample("a", "x")], dev: [] } });
    const mode = statSync(join(tmpRoot, "perm", "v1.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a poisoned __proto__ in the stored JSON does not pollute Object.prototype", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({ name: "pp", version: "v1", splits: { train: [], dev: [] } });
    const p = join(tmpRoot, "pp", "v1.json");
    // Hand-craft a malicious record on disk. The quoted "__proto__" key is the
    // real prototype-pollution attack vector (a JS object literal would drop it).
    const poisoned =
      '{"name":"pp","version":"v1",' +
      '"splits":{"train":[],"dev":[]},' +
      '"sampleHashes":{"train":[],"dev":[]},' +
      '"createdAt":"2026-01-01T00:00:00.000Z",' +
      '"__proto__":{"polluted":true}}';
    writeFileSync(p, poisoned);
    const rec = await reg.getRecord("pp", "v1");
    expect(rec.name).toBe("pp");
    // The global prototype must remain clean: JSON.parse keeps "__proto__" as an
    // own key and never walks it onto Object.prototype.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    // And get() must still iterate the (clean) split without throwing.
    expect(await collect(reg.get("pp", "v1", "train"))).toEqual([]);
  });

  test("get surfaces a not-found error embedding the resolved path", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(collect(reg.get("ghost", "v1", "train"))).rejects.toThrow(
      /dataset "ghost@v1" not found/,
    );
  });
});

describe("dataset-registry — compareVersions natural ordering", () => {
  test("digit runs compare numerically: v2 < v10, 1.0.2 < 1.0.10", () => {
    expect(compareVersions("v2", "v10")).toBeLessThan(0);
    expect(compareVersions("v10", "v2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.2", "1.0.10")).toBeLessThan(0);
    expect(compareVersions("v3", "v3")).toBe(0);
  });

  test("non-digit runs compare lexicographically; digits sort before letters", () => {
    expect(compareVersions("v1-alpha", "v1-beta")).toBeLessThan(0);
    // At the same position, a digit run sorts before a non-digit run.
    expect(compareVersions("v1", "vfinal")).toBeLessThan(0);
  });

  test("prefix versions sort before their extensions", () => {
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
  });

  test("huge digit runs don't lose precision through Number()", () => {
    const a = "v90071992547409919007199254740991";
    const b = "v90071992547409919007199254740992";
    expect(compareVersions(a, b)).toBeLessThan(0);
    expect(compareVersions(b, a)).toBeGreaterThan(0);
  });

  test("sorts a mixed version list into natural order", () => {
    const versions = ["v10", "v2", "v1", "1.0.10", "1.0.2"];
    expect([...versions].sort(compareVersions)).toEqual(["1.0.2", "1.0.10", "v1", "v2", "v10"]);
  });
});

describe("dataset-registry — latestVersion", () => {
  const put = async (
    reg: ReturnType<typeof createFileBackedRegistry>,
    name: string,
    version: string,
  ) => reg.put({ name, version, splits: { train: [sample("a", "x")], dev: [] } });

  test("returns undefined for a dataset with no versions", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    expect(await latestVersion(reg, "missing")).toBeUndefined();
  });

  test("picks the naturally-latest version (v10 beats v2 and v9)", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await put(reg, "x", "v1");
    await put(reg, "x", "v9");
    await put(reg, "x", "v10");
    await put(reg, "x", "v2");
    expect(await latestVersion(reg, "x")).toBe("v10");
  });

  test("orders dotted versions numerically per segment", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await put(reg, "y", "1.0.2");
    await put(reg, "y", "1.0.10");
    expect(await latestVersion(reg, "y")).toBe("1.0.10");
  });
});

describe("dataset-registry — NEW-registry-1 put overwrite guard", () => {
  test("refuses to overwrite an existing version without allowOverwrite", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({ name: "guard", version: "v1", splits: { train: [sample("a", "x")], dev: [] } });
    await expect(
      reg.put({ name: "guard", version: "v1", splits: { train: [sample("b", "y")], dev: [] } }),
    ).rejects.toThrow(/already exists.*allowOverwrite/s);
    // Original content untouched.
    const rec = await reg.getRecord("guard", "v1");
    expect(rec.splits.train[0]?.id).toBe("a");
  });

  test("allowOverwrite: true replaces the version explicitly", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({
      name: "guard2",
      version: "v1",
      splits: { train: [sample("a", "x")], dev: [] },
    });
    const rec = await reg.put(
      { name: "guard2", version: "v1", splits: { train: [sample("b", "y")], dev: [] } },
      { allowOverwrite: true },
    );
    expect(rec.splits.train[0]?.id).toBe("b");
    expect((await reg.getRecord("guard2", "v1")).splits.train[0]?.id).toBe("b");
  });
});

describe("dataset-registry — B22 synthetic-never-gold invariant at put", () => {
  test("refuses a source: synthetic sample carrying expected_output", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const bad: Sample = {
      id: "synth_1",
      input: "q",
      expected_output: "leaked gold",
      metadata: { source: "synthetic" },
    };
    await expect(
      reg.put({ name: "inv", version: "v1", splits: { train: [bad], dev: [] } }),
    ).rejects.toThrow(/synthetic samples never define the gold standard/);
    expect(existsSync(join(tmpRoot, "inv", "v1.json"))).toBe(false);
  });

  test("synthetic_human_verified with a gold, and gold-less synthetic, both pass", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const verified: Sample = {
      id: "shv_1",
      input: "q",
      expected_output: "human-verified gold",
      metadata: { source: "synthetic_human_verified" },
    };
    const goldless: Sample = { id: "synth_2", input: "q2", metadata: { source: "synthetic" } };
    const rec = await reg.put({
      name: "inv2",
      version: "v1",
      splits: { train: [verified, goldless], dev: [] },
    });
    expect(rec.splits.train.length).toBe(2);
  });
});

describe("dataset-registry — NEW-registry-1 verifySplitHashes", () => {
  test("an intact record verifies clean, per split", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({
      name: "ver",
      version: "v1",
      splits: { train: [sample("a", "x")], dev: [sample("b", "y")], test: [sample("c", "z")] },
    });
    const rec = await reg.getRecord("ver", "v1");
    expect(verifySplitHashes(rec)).toEqual([]);
  });

  test("hand-edited sample content is reported with stored vs actual hashes", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({
      name: "ver2",
      version: "v1",
      splits: { train: [sample("a", "x"), sample("b", "y")], dev: [] },
    });
    const path = join(tmpRoot, "ver2", "v1.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.splits.train[1].input = "TAMPERED";
    writeFileSync(path, JSON.stringify(raw));
    const mismatches = verifySplitHashes(await reg.getRecord("ver2", "v1"));
    expect(mismatches.length).toBe(1);
    expect(mismatches[0]?.split).toBe("train");
    expect(mismatches[0]?.index).toBe(1);
    expect(mismatches[0]?.sampleId).toBe("b");
    expect(mismatches[0]?.storedHash).toBeDefined();
    expect(mismatches[0]?.actualHash).toBeDefined();
    expect(mismatches[0]?.storedHash).not.toBe(mismatches[0]?.actualHash);
  });

  test("length divergence (appended sample, dangling hash) is a mismatch", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    await reg.put({ name: "ver3", version: "v1", splits: { train: [sample("a", "x")], dev: [] } });
    const path = join(tmpRoot, "ver3", "v1.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.splits.train.push({ id: "smuggled", input: "extra" });
    writeFileSync(path, JSON.stringify(raw));
    const mismatches = verifySplitHashes(await reg.getRecord("ver3", "v1"));
    expect(mismatches.length).toBe(1);
    expect(mismatches[0]?.sampleId).toBe("smuggled");
    expect(mismatches[0]?.storedHash).toBeUndefined();
  });
});

describe("dataset-registry — NEW-HUNT-9 appendReleaseEntry", () => {
  test("appends onto an empty history and preserves content identity", async () => {
    const reg = createFileBackedRegistry({ rootDir: tmpRoot });
    const before = await reg.put({
      name: "rel",
      version: "v1",
      splits: { train: [sample("a", "x")], dev: [], test: [sample("t", "q")] },
    });
    const updated = appendReleaseEntry({
      rootDir: tmpRoot,
      name: "rel",
      version: "v1",
      entry: { version: "v1", runId: "run_1", ts: "2026-07-25T00:00:00.000Z", passRate: 0.8 },
    });
    expect(updated.releases?.length).toBe(1);
    expect(updated.releases?.[0]?.runId).toBe("run_1");
    // Samples, hashes, createdAt all byte-identical (a release consumes the
    // version, it does not re-author it).
    expect(updated.createdAt).toBe(before.createdAt);
    expect(updated.sampleHashes).toEqual(before.sampleHashes as never);
    expect(verifySplitHashes(await reg.getRecord("rel", "v1"))).toEqual([]);
    // Second release appends (burn count 2).
    const again = appendReleaseEntry({
      rootDir: tmpRoot,
      name: "rel",
      version: "v1",
      entry: { version: "v1", runId: "run_2", ts: "2026-07-25T01:00:00.000Z", passRate: 0.9 },
    });
    expect(again.releases?.map((r) => r.runId)).toEqual(["run_1", "run_2"]);
  });

  test("throws on a missing record", () => {
    expect(() =>
      appendReleaseEntry({
        rootDir: tmpRoot,
        name: "ghost",
        version: "v1",
        entry: { version: "v1", runId: "run_1", ts: "t", passRate: 1 },
      }),
    ).toThrow(DatasetRegistryError);
  });
});
