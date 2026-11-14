/**
 * The holdout split and the held-out use ledger: every read of a version's test
 * split or holdout through `get` leaves one use line beside the version before
 * the first sample leaves; a read never writes; inspection is not consumption.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type DatasetRecord,
  DatasetRegistryError,
  HELD_OUT_USES_READ_CAP,
  HELD_OUT_USE_LINE_MAX_BYTES,
  appendReleaseEntry,
  countHeldOutUses,
  createFileBackedRegistry,
  heldOutUsesPath,
  overallDatasetHash,
  readHeldOutUses,
  recordHeldOutUse,
  verifySplitHashes,
} from "./index";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "held-out-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const s = (id: string, input = id): Sample => ({ id, input });

async function seed(holdout = false): Promise<void> {
  const reg = createFileBackedRegistry({ rootDir: root });
  await reg.put({
    name: "cases",
    version: "v1",
    splits: {
      train: [s("t1"), s("t2")],
      dev: [s("d1")],
      test: [s("x1"), s("x2")],
      ...(holdout ? { holdout: [s("h1"), s("h2")] } : {}),
    },
  });
}

const usesFile = (): string => heldOutUsesPath(root, "cases", "v1");
const lines = (): string[] =>
  existsSync(usesFile())
    ? readFileSync(usesFile(), "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];

describe("a record's digest does not move with the holdout's arrival", () => {
  test("a record written before the holdout split hashes and verifies as it was pinned", () => {
    // A record as `put` wrote it before the holdout existed: three splits.
    const record: DatasetRecord = {
      name: "pinned",
      version: "v1",
      splits: { train: [s("a")], dev: [s("b")], test: [s("c")] },
      sampleHashes: {
        train: ["9a2f7f4a4f6f4d7e"],
        dev: ["1f0c0c3c4b7a2d11"],
        test: ["44c1d5a0e1b2c3d4"],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(overallDatasetHash(record, ["train", "dev", "test"])).toBe(
      "bbb695e5cc929c1c3f7bcd675570147cb1fd6a00c143ee86ecfe039028293cda",
    );
    expect(overallDatasetHash(record, ["train", "dev", "test", "holdout"])).toBe(
      overallDatasetHash(record, ["train", "dev", "test"]),
    );
    expect(verifySplitHashes({ ...record, sampleHashes: {} }).length).toBe(3);
  });
});

describe("get records a held-out read before the first sample", () => {
  test("a test read with allowTestSplit writes exactly one line, even when the reader stops early", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    const it = reg.get("cases", "v1", "test", { allowTestSplit: true })[Symbol.asyncIterator]();
    expect(lines()).toHaveLength(0);
    const first = await it.next();
    expect(first.value?.id).toBe("x1");
    // One line, written before the first sample was handed back.
    expect(lines()).toHaveLength(1);
    await it.return?.();
    const use = JSON.parse(lines()[0] as string);
    expect(use).toMatchObject({ v: 1, split: "test", purpose: "unattributed", via: "library" });
    expect(statSync(usesFile()).mode & 0o777).toBe(0o600);
  });

  test("without the flag the test read is refused and nothing is written", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    await expect(
      (async () => {
        for await (const _ of reg.get("cases", "v1", "test")) void _;
      })(),
    ).rejects.toThrow(/test split locked/);
    expect(existsSync(usesFile())).toBe(false);
  });

  test("a train read records nothing", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    for await (const _ of reg.get("cases", "v1", "train")) void _;
    expect(existsSync(usesFile())).toBe(false);
  });

  test("the holdout needs allowHoldout: refused and nothing written without it, one line with it", async () => {
    await seed(true);
    const reg = createFileBackedRegistry({ rootDir: root });
    await expect(
      (async () => {
        for await (const _ of reg.get("cases", "v1", "holdout", { allowTestSplit: true })) void _;
      })(),
    ).rejects.toThrow(/holdout split locked/);
    expect(existsSync(usesFile())).toBe(false);
    const got: string[] = [];
    for await (const x of reg.get("cases", "v1", "holdout", {
      allowHoldout: true,
      use: { purpose: "promotion", via: "cli", change: "chg_01m76e6f05hp514w9j4v3qymka" },
    })) {
      got.push(x.id);
    }
    expect(got).toEqual(["h1", "h2"]);
    expect(lines().map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({
        split: "holdout",
        purpose: "promotion",
        via: "cli",
        change: "chg_01m76e6f05hp514w9j4v3qymka",
      }),
    ]);
  });

  test("two concurrent reads leave two whole lines", async () => {
    await seed();
    const reg = createFileBackedRegistry({ rootDir: root });
    const read = async () => {
      const out: string[] = [];
      for await (const x of reg.get("cases", "v1", "test", { allowTestSplit: true }))
        out.push(x.id);
      return out;
    };
    await Promise.all([read(), read()]);
    const parsed = lines().map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    for (const use of parsed) expect(use.split).toBe("test");
  });

  for (const kind of ["dangling", "live"] as const) {
    test(`a ${kind} link at the ledger refuses the read and leaves its target untouched`, async () => {
      await seed();
      const target = join(root, "elsewhere.txt");
      if (kind === "live") writeFileSync(target, "keep\n");
      symlinkSync(target, usesFile());
      const reg = createFileBackedRegistry({ rootDir: root });
      await expect(
        (async () => {
          for await (const _ of reg.get("cases", "v1", "test", { allowTestSplit: true })) void _;
        })(),
      ).rejects.toThrow(DatasetRegistryError);
      if (kind === "live") expect(readFileSync(target, "utf8")).toBe("keep\n");
      else expect(existsSync(target)).toBe(false);
    });
  }

  test("a name or version outside the grammar is refused before a path is built", () => {
    expect(() =>
      recordHeldOutUse({
        rootDir: root,
        name: "../escape",
        version: "v1",
        split: "test",
        purpose: "eval",
        via: "cli",
      }),
    ).toThrow(DatasetRegistryError);
    expect(() =>
      recordHeldOutUse({
        rootDir: root,
        name: "cases",
        version: "v1/../x",
        split: "test",
        purpose: "eval",
        via: "cli",
      }),
    ).toThrow(DatasetRegistryError);
  });
});

describe("readHeldOutUses is a read", () => {
  test("legacy releases count once, not again once a release line names their run", async () => {
    await seed();
    appendReleaseEntry({
      rootDir: root,
      name: "cases",
      version: "v1",
      entry: { version: "v1", runId: "run_a", ts: "2026-01-01T00:00:00Z", passRate: 1 },
    });
    let report = readHeldOutUses(root, "cases", "v1");
    expect(report.legacyReleases.map((r) => r.runId)).toEqual(["run_a"]);
    expect(countHeldOutUses(report, "test", "release")).toBe(1);
    recordHeldOutUse({
      rootDir: root,
      name: "cases",
      version: "v1",
      split: "test",
      purpose: "release",
      via: "cli",
      runId: "run_a",
    });
    report = readHeldOutUses(root, "cases", "v1");
    expect(report.legacyReleases).toEqual([]);
    expect(countHeldOutUses(report, "test", "release")).toBe(1);
  });

  test("a torn last line is skipped, never thrown, and the file is byte-identical after", async () => {
    await seed();
    recordHeldOutUse({
      rootDir: root,
      name: "cases",
      version: "v1",
      split: "test",
      purpose: "eval",
      via: "cli",
    });
    writeFileSync(usesFile(), `${readFileSync(usesFile(), "utf8")}{"v":1,"at":"2026`, {
      flag: "w",
    });
    const before = readFileSync(usesFile());
    const report = readHeldOutUses(root, "cases", "v1");
    expect(report.uses).toHaveLength(1);
    expect(report.skipped).toBe(1);
    expect(report.truncated).toBe(false);
    expect(readFileSync(usesFile()).equals(before)).toBe(true);
  });

  test("an absent ledger is present: false, and creates nothing", async () => {
    await seed();
    const report = readHeldOutUses(root, "cases", "v1");
    expect(report).toMatchObject({ present: false, uses: [], skipped: 0, truncated: false });
    expect(existsSync(usesFile())).toBe(false);
  });

  const useLine = (split: string, purpose: string, at = "2026-01-01T00:00:00Z"): string =>
    `${JSON.stringify({ v: 1, at, split, purpose, via: "cli" })}\n`;

  test("the newest lines are the ones read: a release on the last line of an over-cap ledger counts", async () => {
    await seed();
    appendFileSync(
      usesFile(),
      useLine("test", "eval").repeat(HELD_OUT_USES_READ_CAP + 4) + useLine("test", "release"),
    );
    const report = readHeldOutUses(root, "cases", "v1");
    expect(report.truncated).toBe(true);
    expect(report.uses).toHaveLength(HELD_OUT_USES_READ_CAP);
    expect(report.uses.at(-1)?.purpose).toBe("release");
    expect(countHeldOutUses(report, "test", "release")).toBeGreaterThan(0);
  }, 20_000); // writes and parses ten thousand ledger lines

  test("a ledger larger than the read window is read from its end, and the cut line is not counted as skipped", async () => {
    await seed();
    // Few lines, each wide: the byte window, not the line cap, is what is exceeded.
    const pad = "p".repeat(HELD_OUT_USE_LINE_MAX_BYTES * 3);
    const wide = (at: string): string =>
      `${JSON.stringify({ v: 1, at, split: "test", purpose: "eval", via: "cli", pad })}\n`;
    const count = Math.ceil(HELD_OUT_USES_READ_CAP / 3) + 10;
    let text = "";
    for (let i = 0; i < count; i++)
      text += wide(`2026-01-01T00:00:00.${String(i).padStart(6, "0")}Z`);
    appendFileSync(usesFile(), text);
    const report = readHeldOutUses(root, "cases", "v1");
    expect(report.truncated).toBe(true);
    expect(report.skipped).toBe(0);
    expect(report.uses.length).toBeGreaterThan(0);
    expect(report.uses.length).toBeLessThan(count);
    expect(report.uses[0]?.at).not.toBe("2026-01-01T00:00:00.000000Z");
    expect(report.uses.at(-1)?.at).toBe(
      `2026-01-01T00:00:00.${String(count - 1).padStart(6, "0")}Z`,
    );
  }, 20_000); // writes a ledger over ten megabytes

  test("a short ledger is read whole, in file order", async () => {
    await seed();
    appendFileSync(
      usesFile(),
      useLine("test", "eval", "2026-01-01T00:00:01Z") +
        useLine("holdout", "eval", "2026-01-01T00:00:02Z") +
        useLine("test", "release", "2026-01-01T00:00:03Z"),
    );
    const report = readHeldOutUses(root, "cases", "v1");
    expect(report.truncated).toBe(false);
    expect(report.skipped).toBe(0);
    expect(report.uses.map((u) => u.at)).toEqual([
      "2026-01-01T00:00:01Z",
      "2026-01-01T00:00:02Z",
      "2026-01-01T00:00:03Z",
    ]);
  });

  test("getRecord, the inspection read, records no use", async () => {
    await seed(true);
    const reg = createFileBackedRegistry({ rootDir: root });
    const record = await reg.getRecord("cases", "v1");
    expect(record.splits.holdout?.length).toBe(2);
    expect(existsSync(usesFile())).toBe(false);
  });
});

describe("the holdout on a record", () => {
  test("put hashes a present holdout like test, and a record without one has no holdout key", async () => {
    await seed(true);
    const reg = createFileBackedRegistry({ rootDir: root });
    const record = await reg.getRecord("cases", "v1");
    expect(record.sampleHashes.holdout).toHaveLength(2);
    expect(verifySplitHashes(record)).toEqual([]);
    await reg.put({ name: "plain", version: "v1", splits: { train: [s("a")], dev: [] } });
    const plain = await reg.getRecord("plain", "v1");
    expect("holdout" in plain.sampleHashes).toBe(false);
    expect("holdout" in plain.splits).toBe(false);
  });

  test("list() never returns the use ledger as a version", async () => {
    await seed();
    recordHeldOutUse({
      rootDir: root,
      name: "cases",
      version: "v1",
      split: "test",
      purpose: "eval",
      via: "cli",
    });
    const reg = createFileBackedRegistry({ rootDir: root });
    expect(await reg.list("cases")).toEqual(["v1"]);
  });
});
