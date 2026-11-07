import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renameSync, truncateSync, writeFileSync } from "node:fs";
import { type CursorSources, decodeCursor, encodeCursor } from "@crewhaus/control-contract";
import { resume, snapshotAt } from "./cursor";
import { _setIoTapForTest } from "./io";
import { append } from "./ledger";
import { _setRollBytesForTest, segmentRel } from "./segments";
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
  _setIoTapForTest(undefined);
  _setRollBytesForTest(undefined);
});
afterAll(removeTempDirs);

function roundTrips(sources: CursorSources): void {
  const decoded = decodeCursor(encodeCursor({ v: 1, kind: "vector", sources }));
  expect(decoded).toEqual({ ok: true, cursor: { v: 1, kind: "vector", sources } });
}

describe("resume", () => {
  test("brief 324: a torn final line waits, then is delivered exactly once", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const path = segmentPath(runs, 1);
    const head = `${jsonLine({ n: 1 })}${jsonLine({ n: 2 })}`;
    plant(path, `${head}{"n":3`);

    const first = resume({ runs }, undefined, CAPS);
    expect(first.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([1, 2]);
    expect(first.waiting).toBe(true);
    expect(first.next.runs?.[0]?.off).toBe(head.length);

    plant(path, `${head}${jsonLine({ n: 3 })}`);
    const second = resume({ runs }, first.next, CAPS);
    expect(second.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([3]);
    expect(second.waiting).toBe(false);

    const third = resume({ runs }, second.next, CAPS);
    expect(third.items).toEqual([]);
  });

  test("brief 324: a malformed middle line is line, gap, line, and the next call continues", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const a = jsonLine({ n: 1 });
    const bad = "garbage\n";
    const path = segmentPath(runs, 1);
    plant(path, `${a}${bad}${jsonLine({ n: 3 })}`);
    const first = resume({ runs }, undefined, CAPS);
    expect(first.items.map((i) => i.kind)).toEqual(["line", "gap", "line"]);
    expect(first.items[1]).toEqual({
      kind: "gap",
      source: "runs",
      from: { seg: 1, off: a.length },
      to: { seg: 1, off: a.length + bad.length },
      reason: "unreadable",
    });
    append(runs, { n: 4 });
    const second = resume({ runs }, first.next, CAPS);
    expect(second.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([4]);
  });

  test("brief 324: a file replaced by tmp and rename answers a reset, then resumes at `earliest`", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    append(runs, { n: 2 });
    const { next } = resume({ runs }, undefined, CAPS);
    const path = segmentPath(runs, 1);
    const replacement = `${path}.tmp`;
    writeFileSync(replacement, `${jsonLine({ n: 7 })}${jsonLine({ n: 8 })}`);
    renameSync(replacement, path);

    const answer = resume({ runs }, next, CAPS);
    expect(answer.items).toEqual([
      {
        kind: "reset",
        source: "runs",
        reason: "diverged",
        earliest: { seg: 1, off: 0, tail: "" },
      },
    ]);
    expect(answer.next).toEqual({ runs: [{ seg: 1, off: 0, tail: "" }] });
    const again = resume({ runs }, answer.next, CAPS);
    expect(again.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([7, 8]);
  });

  test("brief 324: a file truncated below `off` answers a reset", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    append(runs, { n: 2 });
    const { next } = resume({ runs }, undefined, CAPS);
    truncateSync(segmentPath(runs, 1), 3);
    expect(resume({ runs }, next, CAPS).items.map((i) => i.kind)).toEqual(["reset"]);
  });

  test("brief 324: the same file, untouched and appended to, continues", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    const { next } = resume({ runs }, undefined, CAPS);
    append(runs, { n: 2 });
    const answer = resume({ runs }, next, CAPS);
    expect(answer.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([2]);
  });

  test("the tail covers the 64 bytes before the offset, so a change right there is seen", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const path = segmentPath(runs, 1);
    const pad = jsonLine({ text: "p".repeat(100) });
    plant(path, `${jsonLine({ text: "a".repeat(200) })}${pad}`);
    const { next } = resume({ runs }, undefined, CAPS);

    // More than 64 bytes before the offset is outside what a tail can see.
    plant(path, `${jsonLine({ text: "b".repeat(200) })}${pad}${jsonLine({ n: 3 })}`);
    const far = resume({ runs }, next, CAPS);
    expect(far.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([3]);

    // The same length, with one byte changed inside the window.
    const near = jsonLine({ text: `${"p".repeat(99)}q` });
    plant(path, `${jsonLine({ text: "b".repeat(200) })}${near}${jsonLine({ n: 3 })}`);
    expect(resume({ runs }, next, CAPS).items.map((i) => i.kind)).toEqual(["reset"]);
  });

  test("an absent source at offset 0 is waiting, not a reset", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const deployments = deploymentsLedger(root);
    const answer = resume({ runs, deployments }, undefined, CAPS);
    expect(answer.items).toEqual([]);
    expect(answer.waiting).toBe(true);
    expect(answer.next).toEqual({
      runs: [{ seg: 1, off: 0, tail: "" }],
      deployments: [{ seg: 0, off: 0, tail: "" }],
    });
    roundTrips(answer.next);
    const again = resume({ runs, deployments }, answer.next, CAPS);
    expect(again.items).toEqual([]);
    expect(again.waiting).toBe(true);
  });

  test("a missing file with a real offset is a reset", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const answer = resume({ runs }, { runs: [{ seg: 1, off: 10, tail: "00000000" }] }, CAPS);
    expect(answer.items.map((i) => i.kind)).toEqual(["reset"]);
  });

  test("a source missing from the vector starts at its earliest position", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const deployments = deploymentsLedger(root);
    append(runs, { n: 1 });
    append(deployments, { n: 2 });
    const { next } = resume({ runs }, undefined, CAPS);
    const answer = resume({ runs, deployments }, next, CAPS);
    expect(answer.items).toEqual([
      { kind: "line", source: "deployments", seg: 0, off: 0, record: { n: 2 } },
    ]);
  });

  test("a client vector cannot make it throw: each bad entry answers a reset", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    append(runs, { n: 2 });
    const { next } = resume({ runs }, undefined, CAPS);
    const good = next.runs?.[0];
    if (good === undefined) throw new Error("no position");
    const bad: readonly unknown[] = [
      [{ seg: 1, off: -1, tail: "" }],
      [{ seg: 1, off: 1.5, tail: "00000000" }],
      [{ seg: 1, off: "3", tail: "00000000" }],
      [{ seg: "x", off: 0, tail: "" }],
      [{ seg: 1, off: 5, tail: "" }],
      [{ seg: 1, off: 5, tail: "ZZ" }],
      [{ seg: 1, off: 0, tail: "00000000" }],
      [{ seg: 1, off: 0, tail: "", extra: true }],
      [
        { seg: 2, off: 0, tail: "" },
        { seg: 1, off: 0, tail: "" },
      ],
      [],
      "not-an-array",
      null,
      // A mid-line offset, and one past the end.
      [{ seg: 1, off: good.off - 1, tail: good.tail }],
      [{ seg: 1, off: good.off + 100, tail: good.tail }],
    ];
    for (const entry of bad) {
      const answer = resume({ runs }, { runs: entry } as never, CAPS);
      expect(answer.items).toEqual([
        {
          kind: "reset",
          source: "runs",
          reason: "diverged",
          earliest: { seg: 1, off: 0, tail: "" },
        },
      ]);
      roundTrips(answer.next);
    }
  });

  test("a mid-line offset is a reset even when its tail hash is right", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const text = jsonLine({ n: 1 });
    plant(segmentPath(runs, 1), text);
    const off = text.length - 3;
    const tail = createHash("sha256").update(text.slice(0, off)).digest("hex").slice(0, 8);
    const answer = resume({ runs }, { runs: [{ seg: 1, off, tail }] }, CAPS);
    expect(answer.items.map((i) => i.kind)).toEqual(["reset"]);
  });

  test("something that is not a vector at all resets every source", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    for (const vector of ["text", 7, []]) {
      const answer = resume({ runs }, vector as never, CAPS);
      expect(answer.items.map((i) => i.kind)).toEqual(["reset"]);
    }
  });

  test("a source the vector names but the call did not pass resets, with no earliest, and leaves `next`", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    const answer = resume(
      { runs },
      {
        runs: [{ seg: 1, off: 0, tail: "" }],
        decisions: [{ seg: 1, off: 0, tail: "" }],
        nonsense: "x",
      } as never,
      CAPS,
    );
    expect(answer.items).toEqual([
      { kind: "line", source: "runs", seg: 1, off: 0, record: { n: 1 } },
      { kind: "reset", source: "decisions", reason: "diverged" },
      { kind: "reset", source: "nonsense" as never, reason: "diverged" },
    ]);
    expect(Object.keys(answer.next)).toEqual(["runs"]);
    roundTrips(answer.next);
  });

  test("a position in the wrong shape for a single file resets", () => {
    const root = tempDir();
    const deployments = deploymentsLedger(root);
    append(deployments, { n: 1 });
    const answer = resume({ deployments }, { deployments: [{ seg: 1, off: 0, tail: "" }] }, CAPS);
    expect(answer.items.map((i) => i.kind)).toEqual(["reset"]);
    expect(answer.next).toEqual({ deployments: [{ seg: 0, off: 0, tail: "" }] });
  });

  test("a line longer than maxBytes is a gap, and the reader moves past it", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    plant(
      segmentPath(runs, 1),
      `${jsonLine({ text: "x".repeat(200) })}${jsonLine({ n: 2 })}${jsonLine({ n: 3 })}`,
    );
    const caps = { maxLines: 10, maxBytes: 50 };
    const first = resume({ runs }, undefined, caps);
    expect(first.items.map((i) => i.kind)).toEqual(["gap"]);
    const second = resume({ runs }, first.next, caps);
    expect(second.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([2, 3]);
  });

  test("reads start at the tail window, 64 bytes before the offset, counted", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    plant(segmentPath(runs, 1), `${jsonLine({ text: "x".repeat(500) })}${jsonLine({ n: 2 })}`);
    const { next } = resume({ runs }, undefined, CAPS);
    const off = next.runs?.[0]?.off ?? 0;
    expect(off).toBeGreaterThan(64);
    append(runs, { n: 3 });
    const positions: number[] = [];
    _setIoTapForTest({
      read: (position) => {
        positions.push(position);
      },
    });
    const answer = resume({ runs }, next, CAPS);
    expect(answer.items).toHaveLength(1);
    expect(positions.length).toBeGreaterThan(0);
    expect(Math.min(...positions)).toBe(off - 64);
  });

  test("an offset under 64 bytes reads from the start of the file", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    append(runs, { n: 1 });
    const { next } = resume({ runs }, undefined, CAPS);
    const positions: number[] = [];
    _setIoTapForTest({
      read: (position) => {
        positions.push(position);
      },
    });
    resume({ runs }, next, CAPS);
    expect(Math.min(...positions)).toBe(0);
  });

  test("a capped read continues in the next call with nothing lost", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    for (const n of [1, 2, 3, 4, 5]) append(runs, { n });
    const seen: unknown[] = [];
    let vector: CursorSources | undefined;
    for (let call = 0; call < 3; call += 1) {
      const answer = resume({ runs }, vector, { maxLines: 2, maxBytes: 1024 });
      expect(answer.items.length).toBeLessThanOrEqual(2);
      for (const item of answer.items) if (item.kind === "line") seen.push(item.record["n"]);
      vector = answer.next;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  test("the byte cap ends a read at a line boundary, and the next call continues", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const line = jsonLine({ n: 1 });
    for (let i = 0; i < 6; i += 1) append(runs, { n: 1 });
    const answer = resume({ runs }, undefined, { maxLines: 100, maxBytes: line.length * 2 });
    expect(answer.items).toHaveLength(2);
    const rest = resume({ runs }, answer.next, { maxLines: 100, maxBytes: 1024 });
    expect(rest.items).toHaveLength(4);
  });

  test("caps are per source", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const deployments = deploymentsLedger(root);
    for (const n of [1, 2, 3]) {
      append(runs, { n });
      append(deployments, { n });
    }
    const answer = resume({ runs, deployments }, undefined, { maxLines: 2, maxBytes: 1024 });
    expect(answer.items.filter((i) => i.source === "runs")).toHaveLength(2);
    expect(answer.items.filter((i) => i.source === "deployments")).toHaveLength(2);
  });

  test("a cap reached in the older position keeps the newer one in `next`", () => {
    _setRollBytesForTest(40);
    const root = tempDir();
    const runs = runsLedger(root);
    const pad = "x".repeat(50);
    append(runs, { pad });
    append(runs, { pad });
    const vector = snapshotAt({ runs });
    expect(vector.runs?.map((p) => p.seg)).toEqual([1, 2]);
    plant(segmentPath(runs, 1), `${jsonLine({ pad })}${jsonLine({ n: 1 })}${jsonLine({ n: 2 })}`);
    const answer = resume({ runs }, vector, { maxLines: 1, maxBytes: 1024 });
    expect(answer.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([1]);
    expect(answer.next.runs?.map((p) => p.seg)).toEqual([1, 2]);
    roundTrips(answer.next);
    const rest = resume({ runs }, answer.next, CAPS);
    expect(rest.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([2]);
  });
});

describe("snapshotAt", () => {
  test("list, then resume from snapshotAt, with an append after the page: no gap and no duplicate", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    for (const n of [1, 2]) append(runs, { n });
    const page = readPage(runs, { limit: 10 });
    append(runs, { n: 3 });
    expect(page.items.map((i) => i.record["n"])).toEqual([2, 1]);
    const answer = resume({ runs }, { runs: page.snapshotAt }, CAPS);
    expect(answer.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([3]);
  });

  test("a line landing between the snapshot and the page's scan is ignored by the page, and resumed once", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    for (const n of [1, 2]) append(runs, { n });
    const rel = segmentRel(runs.records, 1);
    // How many times one page opens the newest segment: its snapshot first, its scan last.
    let opens = 0;
    _setIoTapForTest({
      open: (given) => {
        if (given === rel) opens += 1;
      },
    });
    readPage(runs, { limit: 10 });
    expect(opens).toBeGreaterThanOrEqual(2);
    const scanOpen = opens;

    // Now land a line just before the scan opens the segment, after the snapshot was taken.
    let seen = 0;
    let appending = false;
    _setIoTapForTest({
      open: (given) => {
        if (appending || given !== rel) return;
        seen += 1;
        if (seen !== scanOpen) return;
        appending = true;
        expect(append(runs, { n: 3 })).toMatchObject({ ok: true, seg: 1 });
        appending = false;
      },
    });
    const page = readPage(runs, { limit: 10 });
    _setIoTapForTest(undefined);
    expect(seen).toBe(scanOpen);
    expect(page.items.map((i) => i.record["n"])).toEqual([2, 1]);
    const answer = resume({ runs }, { runs: page.snapshotAt }, CAPS);
    expect(answer.items.map((i) => i.kind === "line" && i.record["n"])).toEqual([3]);
    expect(resume({ runs }, answer.next, CAPS).items).toEqual([]);
  });

  test("the snapshot ends at the last complete line, before a torn one", () => {
    const root = tempDir();
    const runs = runsLedger(root);
    const line = jsonLine({ n: 1 });
    plant(segmentPath(runs, 1), `${line}{"n":2`);
    const vector = snapshotAt({ runs });
    expect(vector.runs?.[0]?.off).toBe(line.length);
    roundTrips(vector);
  });

  test("after a roll it holds the newest two segments, and a late line in the older is delivered", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const runs = runsLedger(root);
    for (const n of [1, 2, 3]) append(runs, { n });
    const vector = snapshotAt({ runs });
    expect(vector.runs?.map((p) => p.seg)).toEqual([2, 3]);
    roundTrips(vector);
    // The way a writer that opened segment 2 before the roll lands its line.
    plant(segmentPath(runs, 2), `${jsonLine({ n: 2 })}${jsonLine({ n: "late" })}`);
    const answer = resume({ runs }, vector, CAPS);
    expect(answer.items.map((i) => i.kind === "line" && i.record["n"])).toEqual(["late"]);
  });

  test("absent sources get their first position, and the result always encodes", () => {
    const root = tempDir();
    const vector = snapshotAt({ runs: runsLedger(root), deployments: deploymentsLedger(root) });
    expect(vector).toEqual({
      runs: [{ seg: 1, off: 0, tail: "" }],
      deployments: [{ seg: 0, off: 0, tail: "" }],
    });
    roundTrips(vector);
  });

  test("every next and snapshot round-trips through the codec", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const runs = runsLedger(root);
    const deployments = deploymentsLedger(root);
    let vector: CursorSources | undefined;
    for (const n of [1, 2, 3, 4]) {
      append(runs, { n });
      append(deployments, { n });
      roundTrips(snapshotAt({ runs, deployments }));
      const answer = resume({ runs, deployments }, vector, CAPS);
      roundTrips(answer.next);
      vector = answer.next;
    }
  });
});
