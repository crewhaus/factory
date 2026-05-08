/**
 * Section 29 — `dataset-registry` tests:
 *  - T1 file backend round-trip
 *  - T8 split-leak prevention
 *  - T9 hash-stability
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import { DatasetRegistryError, createFileBackedRegistry } from "./index";

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
});
