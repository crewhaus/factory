import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { resume, snapshotAt } from "./cursor";
import { append } from "./ledger";
import { _setRetentionSeamsForTest, dropSegmentsBefore } from "./retention";
import { _setRollBytesForTest, appendTarget, segmentRel, watermarkRel } from "./segments";
import { readPage } from "./tail";
import {
  deploymentsLedger,
  jsonLine,
  plant,
  removeTempDirs,
  runsLedger,
  segmentPath,
  tempDir,
} from "./test-helpers";

const CAPS = { maxLines: 100, maxBytes: 1024 * 1024 };

afterEach(() => {
  _setRollBytesForTest(undefined);
  _setRetentionSeamsForTest(undefined);
});
afterAll(removeTempDirs);

function lineNumbers(answer: ReturnType<typeof resume>): unknown[] {
  return answer.items.flatMap((i) => (i.kind === "line" ? [i.record["n"]] : []));
}

describe("rolling", () => {
  test("the first segment is 000001.jsonl", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(append(ledger, { n: 1 })).toEqual({ ok: true, seg: 1 });
    expect(readdirSync(join(root, ledger.records.dir as string))).toEqual(["000001.jsonl"]);
  });

  test("a segment under the threshold keeps its lines", () => {
    _setRollBytesForTest(1024);
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(append(ledger, { n: 1 })).toEqual({ ok: true, seg: 1 });
    expect(append(ledger, { n: 2 })).toEqual({ ok: true, seg: 1 });
  });

  test("once a segment has passed the threshold the writer starts the next, and the old one keeps its inode", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(append(ledger, { n: 1 })).toEqual({ ok: true, seg: 1 });
    const inode = statSync(segmentPath(ledger, 1)).ino;
    const bytes = readFileSync(segmentPath(ledger, 1), "utf8");
    expect(append(ledger, { n: 2 })).toEqual({ ok: true, seg: 2 });
    expect(statSync(segmentPath(ledger, 1)).ino).toBe(inode);
    expect(readFileSync(segmentPath(ledger, 1), "utf8")).toBe(bytes);
    expect(readFileSync(segmentPath(ledger, 2), "utf8")).toBe(jsonLine({ n: 2 }));
  });

  test("two racing rollers land in the one new segment", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = runsLedger(root);
    append(ledger, { n: 1 });
    // Both have listed and chosen; neither has created the file yet.
    const first = appendTarget(ledger);
    const second = appendTarget(ledger);
    if (!first.ok || !second.ok) throw new Error("no target");
    expect(first.seg).toBe(2);
    expect(second.seg).toBe(2);
    const options = { mode: 0o600, hardLinks: "refuse" } as const;
    expect(appendContained(root, first.rel, jsonLine({ n: 2 }), options).ok).toBe(true);
    expect(appendContained(root, second.rel, jsonLine({ n: 3 }), options).ok).toBe(true);
    expect(readFileSync(segmentPath(ledger, 2), "utf8")).toBe(
      `${jsonLine({ n: 2 })}${jsonLine({ n: 3 })}`,
    );
    expect(existsSync(segmentPath(ledger, 3))).toBe(false);
  });

  test("a single-file ledger never rolls past the threshold, and its positions are at segment 0", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = deploymentsLedger(root);
    for (const n of [1, 2, 3]) expect(append(ledger, { n })).toEqual({ ok: true, seg: 0 });
    expect(readdirSync(join(root, ".crewhaus", "run", "control"))).toEqual(["deployments.jsonl"]);
    expect(snapshotAt({ deployments: ledger }).deployments?.map((p) => p.seg)).toEqual([0]);
    const answer = resume({ deployments: ledger }, undefined, CAPS);
    expect(answer.next.deployments?.map((p) => p.seg)).toEqual([0]);
  });

  test("other names in the directory are ignored", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const dir = join(root, ledger.records.dir as string);
    plant(join(dir, "000009.jsonl.tmp"), "x");
    plant(join(dir, "abc.jsonl"), "x");
    plant(join(dir, "99.jsonl"), "x");
    expect(append(ledger, { n: 1 })).toEqual({ ok: true, seg: 1 });
  });
});

describe("a late line after a roll", () => {
  test("brief 324: it is delivered once, and the vector then holds exactly the last two segments", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    append(runs, { n: 2 });
    const { next, items } = resume({ runs }, undefined, CAPS);
    expect(items).toHaveLength(2);
    expect(next.runs?.map((p) => p.seg)).toEqual([1, 2]);

    // The way a writer that opened segment 1 before the roll lands its line.
    const late = appendContained(root, segmentRel(runs.records, 1), jsonLine({ n: "late" }), {
      create: false,
    });
    expect(late.ok).toBe(true);
    const delivered = resume({ runs }, next, CAPS);
    expect(lineNumbers(delivered)).toEqual(["late"]);
    expect(lineNumbers(resume({ runs }, delivered.next, CAPS))).toEqual([]);

    append(runs, { n: 3 });
    const rolled = resume({ runs }, delivered.next, CAPS);
    expect(lineNumbers(rolled)).toEqual([3]);
    expect(rolled.next.runs?.map((p) => p.seg)).toEqual([2, 3]);
  });

  test("a reader far behind reads forward and keeps the source's newest two", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    const { next } = resume({ runs }, undefined, CAPS);
    for (const n of [2, 3, 4]) append(runs, { n });
    const answer = resume({ runs }, next, CAPS);
    expect(lineNumbers(answer)).toEqual([2, 3, 4]);
    expect(answer.next.runs?.map((p) => p.seg)).toEqual([3, 4]);
  });
});

describe("watermarks", () => {
  function threeSegments(): { root: string; runs: ReturnType<typeof runsLedger> } {
    _setRollBytesForTest(1);
    const root = tempDir();
    const runs = runsLedger(root);
    for (const n of [1, 2, 3]) append(runs, { n });
    return { root, runs };
  }

  test("the watermark is written before anything is unlinked", async () => {
    const { root, runs } = threeSegments();
    let seen: { readonly mark: boolean; readonly first: boolean } | undefined;
    _setRetentionSeamsForTest({
      afterWatermark: () => {
        seen = {
          mark: existsSync(join(root, watermarkRel(runs.records as { dir: string }))),
          first: existsSync(segmentPath(runs, 1)),
        };
      },
    });
    expect(await dropSegmentsBefore(runs, 3)).toEqual({ ok: true, watermark: 3, dropped: [1, 2] });
    expect(seen).toEqual({ mark: true, first: true });
    expect(existsSync(segmentPath(runs, 1))).toBe(false);
    expect(existsSync(segmentPath(runs, 2))).toBe(false);
    expect(existsSync(segmentPath(runs, 3))).toBe(true);
  });

  test("a vector below the watermark gets an evicted gap, then continues at the watermark", async () => {
    const { runs } = threeSegments();
    const vector = { runs: [{ seg: 1, off: 0, tail: "" }] };
    await dropSegmentsBefore(runs, 2);
    const answer = resume({ runs }, vector, CAPS);
    expect(answer.items[0]).toEqual({
      kind: "gap",
      source: "runs",
      from: { seg: 1, off: 0 },
      to: { seg: 2, off: 0 },
      reason: "evicted",
    });
    expect(lineNumbers(answer)).toEqual([2, 3]);
  });

  test("a segment file still on disk below the watermark is evicted", async () => {
    const { root, runs } = threeSegments();
    const kept = readFileSync(segmentPath(runs, 1), "utf8");
    await dropSegmentsBefore(runs, 2);
    // A crash between the watermark and the unlink leaves exactly this.
    plant(segmentPath(runs, 1), kept);
    expect(existsSync(join(root, segmentRel(runs.records, 1)))).toBe(true);
    const answer = resume({ runs }, { runs: [{ seg: 1, off: 0, tail: "" }] }, CAPS);
    expect(answer.items[0]).toMatchObject({ kind: "gap", reason: "evicted" });
    expect(lineNumbers(answer)).toEqual([2, 3]);
    expect(readPage(runs, { limit: 10 }).items.map((i) => i.record["n"])).toEqual([3, 2]);
    expect(lineNumbers(resume({ runs }, undefined, CAPS))).toEqual([2, 3]);
  });

  test("two positions with the older evicted: one gap, then only lines past the newer", async () => {
    const { runs } = threeSegments();
    const vector = snapshotAt({ runs });
    expect(vector.runs?.map((p) => p.seg)).toEqual([2, 3]);
    await dropSegmentsBefore(runs, 3);
    append(runs, { n: 4 }); // into segment 4: the threshold has passed
    const answer = resume({ runs }, vector, CAPS);
    expect(answer.items.filter((i) => i.kind === "gap")).toEqual([
      {
        kind: "gap",
        source: "runs",
        from: { seg: 2, off: vector.runs?.[0]?.off ?? -1 },
        to: { seg: 3, off: vector.runs?.[1]?.off ?? -1 },
        reason: "evicted",
      },
    ]);
    // Segment 3 is not re-read from 0: it was already delivered.
    expect(lineNumbers(answer)).toEqual([4]);
  });

  test("two positions both evicted: one gap, from the older", async () => {
    const { runs } = threeSegments();
    append(runs, { n: 4 });
    const vector = {
      runs: [
        { seg: 1, off: 0, tail: "" },
        { seg: 2, off: 0, tail: "" },
      ],
    };
    await dropSegmentsBefore(runs, 4);
    const answer = resume({ runs }, vector, CAPS);
    expect(answer.items.filter((i) => i.kind === "gap")).toEqual([
      {
        kind: "gap",
        source: "runs",
        from: { seg: 1, off: 0 },
        to: { seg: 4, off: 0 },
        reason: "evicted",
      },
    ]);
    expect(lineNumbers(answer)).toEqual([4]);
  });

  test("the watermark never falls", async () => {
    const { root, runs } = threeSegments();
    await dropSegmentsBefore(runs, 3);
    const rel = watermarkRel(runs.records as { dir: string });
    const before = readFileSync(join(root, rel), "utf8");
    expect(await dropSegmentsBefore(runs, 2)).toEqual({ ok: true, watermark: 3, dropped: [] });
    expect(await dropSegmentsBefore(runs, 3)).toEqual({ ok: true, watermark: 3, dropped: [] });
    expect(readFileSync(join(root, rel), "utf8")).toBe(before);
  });

  test("the newest segment survives a seg above it", async () => {
    const { runs } = threeSegments();
    expect(await dropSegmentsBefore(runs, 99)).toEqual({ ok: true, watermark: 3, dropped: [1, 2] });
    expect(existsSync(segmentPath(runs, 3))).toBe(true);
    expect(lineNumbers(resume({ runs }, undefined, CAPS))).toEqual([3]);
  });

  test("the watermark file holds {v, seg, at}", async () => {
    const { root, runs } = threeSegments();
    await dropSegmentsBefore(runs, 2);
    const body = JSON.parse(
      readFileSync(join(root, watermarkRel(runs.records as { dir: string })), "utf8"),
    );
    expect(Object.keys(body).sort()).toEqual(["at", "seg", "v"]);
    expect(body.v).toBe(1);
    expect(body.seg).toBe(2);
  });

  test("an empty ledger has nothing to drop", async () => {
    const root = tempDir();
    expect(await dropSegmentsBefore(runsLedger(root), 5)).toEqual({
      ok: true,
      watermark: 0,
      dropped: [],
    });
  });

  test("a single-file ledger has no segments to drop, and says so", async () => {
    const root = tempDir();
    const answer = await dropSegmentsBefore(deploymentsLedger(root), 5);
    expect(answer).toMatchObject({ ok: false, code: "invalid-path" });
  });

  test("a watermark that does not parse is refused, not read as none", async () => {
    const { root, runs } = threeSegments();
    const rel = watermarkRel(runs.records as { dir: string });
    expect(writeFileSafe(root, rel, "not json\n", { overwrite: true }).ok).toBe(true);
    const answer = resume({ runs }, undefined, CAPS);
    expect(answer.items).toEqual([expect.objectContaining({ kind: "gap", reason: "unreadable" })]);
    expect(readPage(runs, { limit: 5 }).items).toEqual([]);
    expect(await dropSegmentsBefore(runs, 3)).toMatchObject({ ok: false, code: "io-error" });
  });
});
