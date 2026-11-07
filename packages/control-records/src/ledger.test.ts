import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { _setIoTapForTest } from "./io";
import {
  _setLedgerSeamsForTest,
  append,
  appendClaim,
  casAppend,
  foldStates,
  publishClaim,
  readClaim,
  withLedgerLock,
} from "./ledger";
import { dropSegmentsBefore } from "./retention";
import { _setRollBytesForTest } from "./segments";
import { readPage, readTail } from "./tail";
import {
  deploymentsLedger,
  gate,
  jsonLine,
  noWarn,
  plant,
  removeTempDirs,
  runsLedger,
  segmentPath,
  tempDir,
} from "./test-helpers";

const CAPS = { maxLines: 100, maxBytes: 1024 * 1024 };
// Any lock is older than this, whatever a filesystem's timestamps say about "now".
const STEAL = { staleMs: -60_000, ...noWarn };

afterEach(() => {
  _setLedgerSeamsForTest(undefined);
  _setRollBytesForTest(undefined);
  _setIoTapForTest(undefined);
});
afterAll(removeTempDirs);

function lines(path: string): readonly Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

describe("one claim winner under an injected lock steal (brief 324)", () => {
  test("A held before its claim: B wins, A loses and repairs nothing", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const a = gate();
    _setLedgerSeamsForTest({ lockOptions: noWarn, afterLock: a.hold });
    const writerA = appendClaim(ledger, { claim: "idem/one", record: { id: "x", who: "a" } });
    await a.reached;

    _setLedgerSeamsForTest({ lockOptions: STEAL });
    const b = await appendClaim(ledger, { claim: "idem/one", record: { id: "x", who: "b" } });
    a.open();
    const answerA = await writerA;

    expect(b).toEqual({ ok: true, won: true, seg: 1 });
    expect(answerA).toMatchObject({ ok: true, won: false });
    if (!answerA.ok || answerA.won) throw new Error("A must lose");
    expect(answerA.winner.claim).toBe("idem/one");
    expect(answerA.winner.record).toEqual({ id: "x", who: "b" });
    expect(answerA.repaired).toBeUndefined();

    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.records).toBe(1);
    expect(lines(segmentPath(ledger, 1))).toEqual([{ id: "x", who: "b", claim: "idem/one" }]);
  });

  test("A held after its claim, before its append: A wins, B loses and repairs, A appends too", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const a = gate();
    _setLedgerSeamsForTest({ lockOptions: noWarn, afterClaim: a.hold });
    const writerA = appendClaim(ledger, { claim: "idem/one", record: { id: "x", who: "a" } });
    await a.reached;

    _setLedgerSeamsForTest({ lockOptions: STEAL });
    const b = await appendClaim(ledger, { claim: "idem/one", record: { id: "x", who: "b" } });
    a.open();
    const answerA = await writerA;

    expect(answerA).toEqual({ ok: true, won: true, seg: 1 });
    if (!b.ok || b.won) throw new Error("B must lose");
    expect(b.winner.record).toEqual({ id: "x", who: "a" });
    expect(b.repaired).toBe(true);

    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.records).toBe(1);
    expect(fold.anomalies).toEqual([]);
    // A page shows raw lines, so it shows both, under one claim.
    const page = readPage(ledger, { limit: 10 });
    expect(page.items.map((i) => i.record["claim"])).toEqual(["idem/one", "idem/one"]);
    expect(page.items.map((i) => i.record["repaired"])).toEqual([undefined, true]);
  });

  test("a stolen lock really does let both run: without it the second writer would wait", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const a = gate();
    _setLedgerSeamsForTest({ lockOptions: noWarn, afterLock: a.hold });
    const writerA = withLedgerLock(ledger, () => "a");
    await a.reached;
    _setLedgerSeamsForTest({ lockOptions: { waitMs: 0, ...noWarn } });
    await expect(withLedgerLock(ledger, () => "b")).rejects.toThrow(/is held by pid/);
    a.open();
    expect(await writerA).toBe("a");
  });
});

describe("crash repair", () => {
  test("a winner stopped between claim and append is completed on the next touch, once", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    _setLedgerSeamsForTest({
      afterClaim: () => {
        throw new Error("crash");
      },
    });
    await expect(
      appendClaim(ledger, { claim: "idem/one", record: { id: "x", n: 1 } }),
    ).rejects.toThrow("crash");
    _setLedgerSeamsForTest(undefined);
    expect(existsSync(segmentPath(ledger, 1))).toBe(false);

    const touch = await appendClaim(ledger, { claim: "idem/one", record: { id: "other" } });
    if (!touch.ok || touch.won) throw new Error("the touch must lose");
    expect(touch.repaired).toBe(true);
    expect(touch.winner.record).toEqual({ id: "x", n: 1 });
    expect(lines(segmentPath(ledger, 1))).toEqual([
      { id: "x", n: 1, claim: "idem/one", repaired: true },
    ]);

    const again = await appendClaim(ledger, { claim: "idem/one", record: { id: "other" } });
    if (!again.ok || again.won) throw new Error("the touch must lose");
    expect(again.repaired).toBeUndefined();
    expect(lines(segmentPath(ledger, 1))).toHaveLength(1);
  });

  test("a claim from a segment below the watermark is never repaired", async () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = runsLedger(root);
    append(ledger, { n: 1 });
    expect(publishClaim(ledger, "gen/x/1", { id: "x", gen: 1 })).toMatchObject({
      ok: true,
      content: { seg: 2 },
    });
    append(ledger, { n: 2 });
    append(ledger, { n: 3 });
    await dropSegmentsBefore(ledger, 3);
    const answer = await casAppend(ledger, "x", null, { state: "new" });
    expect(answer).toEqual({ ok: true, applied: false, current: { id: "x", gen: 1 } });
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.objects.has("x")).toBe(false);
    expect(lines(segmentPath(ledger, 3))).toEqual([{ n: 3 }]);
  });

  test("a line from the claim's segment onward counts, wherever it landed", async () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = runsLedger(root);
    append(ledger, { n: 1 });
    await appendClaim(ledger, { claim: "idem/one", record: { n: 2 } });
    append(ledger, { n: 3 });
    const touch = await appendClaim(ledger, { claim: "idem/one", record: { n: 9 } });
    if (!touch.ok || touch.won) throw new Error("the touch must lose");
    expect(touch.repaired).toBeUndefined();
  });

  test("a refused segment refuses the repair rather than guessing", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(publishClaim(ledger, "idem/one", { n: 1 }).ok).toBe(true);
    plant(join(root, ledger.records.dir as string, "000001.jsonl", "file"), "x");
    const touch = await appendClaim(ledger, { claim: "idem/one", record: { n: 2 } });
    expect(touch).toMatchObject({ ok: false });
  });
});

describe("claims directly", () => {
  test("a second publish answers `exists`, and the first stays", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const first = publishClaim(ledger, "idem/one", { who: "first" });
    expect(first.ok).toBe(true);
    const second = publishClaim(ledger, "idem/one", { who: "second" });
    expect(second).toMatchObject({ ok: false, code: "exists" });
    const read = readClaim(ledger, "idem/one");
    if (!read.ok) throw new Error(read.reason);
    expect(read.content.record).toEqual({ who: "first" });
  });

  test("a claim file holds {v, claim, at, seg, record}", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    _setLedgerSeamsForTest({ now: () => Date.parse("2026-11-07T12:00:00.000Z") });
    publishClaim(ledger, "idem/one", { who: "first" });
    const path = join(root, ledger.claims, "idem", "one.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      v: 1,
      claim: "idem/one",
      at: "2026-11-07T12:00:00.000Z",
      seg: 1,
      record: { who: "first" },
    });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, ledger.claims, "idem")).mode & 0o777).toBe(0o700);
    }
  });

  test("`gen/<object>/<n>` publishes to two segments", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(publishClaim(ledger, "gen/obj_1/2", { n: 1 }).ok).toBe(true);
    expect(existsSync(join(root, ledger.claims, "gen", "obj_1", "2.json"))).toBe(true);
    expect(readClaim(ledger, "gen/obj_1/2").ok).toBe(true);
  });

  const BAD_CLAIMS = [
    "../x",
    "idem/../x",
    "idem/a/b",
    "IDEM/x",
    "gen/obj",
    "gen/obj/0",
    "gen/obj/x",
    "gen/obj/1/2",
    "gen/../1",
    "idem/.hidden",
    "idem/",
    "/idem/x",
    "idem",
    "",
    "idem/a b",
  ];

  test("a malformed claim is refused by both, with nothing created", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    for (const claim of BAD_CLAIMS) {
      expect(publishClaim(ledger, claim, { n: 1 })).toMatchObject({
        ok: false,
        code: "invalid-path",
      });
      expect(readClaim(ledger, claim)).toMatchObject({ ok: false, code: "invalid-path" });
    }
    expect(readdirSync(root)).toEqual([]);
  });

  test("appendClaim refuses a malformed claim too", async () => {
    const root = tempDir();
    const answer = await appendClaim(runsLedger(root), { claim: "../x", record: { n: 1 } });
    expect(answer).toMatchObject({ ok: false, code: "invalid-path" });
  });

  test("a missing claim reads as `not-found`", () => {
    const root = tempDir();
    expect(readClaim(runsLedger(root), "idem/none")).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  test("a claim file that does not hold this claim is refused, never repaired from", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    plant(join(root, ledger.claims, "idem", "one.json"), jsonLine({ v: 1, claim: "idem/two" }));
    expect(readClaim(ledger, "idem/one")).toMatchObject({ ok: false, code: "io-error" });
    const touch = await appendClaim(ledger, { claim: "idem/one", record: { n: 1 } });
    expect(touch).toMatchObject({ ok: false, code: "io-error" });
    expect(existsSync(segmentPath(ledger, 1))).toBe(false);
  });

  test("a claim too large to read back is refused at publish", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const answer = publishClaim(ledger, "idem/one", { text: "x".repeat(1024 * 1024) });
    expect(answer).toMatchObject({ ok: false, code: "too-large" });
    expect(existsSync(join(root, ledger.claims, "idem", "one.json"))).toBe(false);
  });
});

describe("casAppend", () => {
  test("an absent object enters at an entry state, and the row is stamped", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root, "deployment");
    const answer = await casAppend(ledger, "dep_a", null, { state: "prepared", by: "prn" });
    expect(answer).toEqual({
      ok: true,
      applied: true,
      gen: 1,
      seg: 0,
      record: { state: "prepared", by: "prn", id: "dep_a", gen: 1, claim: "gen/dep_a/1" },
    });
    expect(lines(segmentPath(ledger, 0))).toHaveLength(1);
  });

  test("a stale expectState answers the current record", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root, "deployment");
    await casAppend(ledger, "dep_a", null, { state: "prepared" });
    await casAppend(ledger, "dep_a", "prepared", { state: "active" });
    const stale = await casAppend(ledger, "dep_a", "prepared", { state: "active" });
    expect(stale).toMatchObject({ ok: true, applied: false, current: { state: "active", gen: 2 } });
    const again = await casAppend(ledger, "dep_a", null, { state: "prepared" });
    expect(again).toMatchObject({ ok: true, applied: false, current: { state: "active" } });
    const absent = await casAppend(ledger, "dep_b", "active", { state: "disabled" });
    expect(absent).toEqual({ ok: true, applied: false, current: null });
  });

  test("an illegal transition and a non-entry first state are refused as illegal", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root, "deployment");
    const first = await casAppend(ledger, "dep_a", null, { state: "active" });
    expect(first).toEqual({ ok: true, applied: false, current: null, illegal: true });
    await casAppend(ledger, "dep_a", null, { state: "prepared" });
    const jump = await casAppend(ledger, "dep_a", "prepared", { state: "retired" });
    expect(jump).toMatchObject({ applied: false, illegal: true, current: { state: "prepared" } });
    expect(lines(segmentPath(ledger, 0))).toHaveLength(1);
  });

  test("with no machine there is no transition check", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root);
    expect(await casAppend(ledger, "x", null, { state: "anything" })).toMatchObject({
      applied: true,
    });
    expect(await casAppend(ledger, "x", "anything", { state: "else" })).toMatchObject({
      applied: true,
    });
  });

  test("two racing under a steal: one applied, whichever point the first is held at", async () => {
    for (const held of ["afterLock", "afterFold", "afterClaim"] as const) {
      const root = tempDir();
      const ledger = runsLedger(root, "deployment");
      const a = gate();
      _setLedgerSeamsForTest({ lockOptions: noWarn, [held]: a.hold });
      const writerA = casAppend(ledger, "dep_a", null, { state: "prepared", who: "a" });
      await a.reached;
      _setLedgerSeamsForTest({ lockOptions: STEAL });
      const b = await casAppend(ledger, "dep_a", null, { state: "prepared", who: "b" });
      a.open();
      const answerA = await writerA;

      if (!answerA.ok || !b.ok) throw new Error("a refusal");
      expect([answerA.applied, b.applied].filter(Boolean)).toHaveLength(1);
      const winner = answerA.applied ? "a" : "b";
      const loser = answerA.applied ? b : answerA;
      expect(loser).toMatchObject({ applied: false, current: { who: winner } });
      const fold = foldStates(ledger);
      if (!fold.ok) throw new Error(fold.reason);
      expect(fold.records).toBe(1);
      expect(fold.objects.get("dep_a")?.record["gen"]).toBe(1);
      expect(fold.anomalies).toEqual([]);
    }
  });

  test("generation claims remain, one per generation", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root, "deployment");
    await casAppend(ledger, "dep_a", null, { state: "prepared" });
    await casAppend(ledger, "dep_a", "prepared", { state: "active" });
    await casAppend(ledger, "dep_a", "active", { state: "disabled" });
    expect(readdirSync(join(root, ledger.claims, "gen", "dep_a")).sort()).toEqual([
      "1.json",
      "2.json",
      "3.json",
    ]);
  });

  test("a crash after the generation claim is repaired by the next attempt, which loses", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root, "deployment");
    _setLedgerSeamsForTest({
      afterClaim: () => {
        throw new Error("crash");
      },
    });
    await expect(casAppend(ledger, "dep_a", null, { state: "prepared" })).rejects.toThrow("crash");
    _setLedgerSeamsForTest(undefined);
    const next = await casAppend(ledger, "dep_a", null, { state: "prepared", who: "next" });
    expect(next).toMatchObject({ applied: false, current: { state: "prepared", gen: 1 } });
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.objects.get("dep_a")?.state).toBe("prepared");
    expect(await casAppend(ledger, "dep_a", "prepared", { state: "active" })).toMatchObject({
      applied: true,
      gen: 2,
    });
  });

  test("an id that cannot be a claim name is refused, with nothing written", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root);
    const answer = await casAppend(ledger, "../x", null, { state: "a" });
    expect(answer).toMatchObject({ ok: false, code: "invalid-path" });
    expect(existsSync(segmentPath(ledger, 0))).toBe(false);
  });

  test("a next state with no string is illegal on a machine", async () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root, "deployment");
    expect(await casAppend(ledger, "dep_a", null, {})).toMatchObject({ illegal: true });
  });
});

describe("foldStates", () => {
  test("an illegal row is kept, counted and not applied", () => {
    const root = tempDir();
    const ledger = runsLedger(root, "deployment");
    append(ledger, { id: "d", state: "prepared" });
    append(ledger, { id: "d", state: "retired" }); // prepared may only go active
    append(ledger, { id: "d", state: "active" });
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.objects.get("d")?.state).toBe("active");
    expect(fold.records).toBe(3);
    expect(fold.anomalies).toEqual([
      {
        id: "d",
        from: "prepared",
        to: "retired",
        at: { seg: 1, off: jsonLine({ id: "d", state: "prepared" }).length },
      },
    ]);
    expect(lines(segmentPath(ledger, 1))).toHaveLength(3);
  });

  test("a non-entry first row is an anomaly, and the object stays absent", () => {
    const root = tempDir();
    const ledger = runsLedger(root, "deployment");
    append(ledger, { id: "d", state: "active" });
    append(ledger, { id: "e", gen: 1 });
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.objects.size).toBe(0);
    expect(fold.anomalies).toEqual([
      { id: "d", from: null, to: "active", at: { seg: 1, off: 0 } },
      expect.objectContaining({ id: "e", from: null, to: null }),
    ]);
  });

  test("a repaired claim's second line is neither a second fact nor a self-transition", async () => {
    const root = tempDir();
    const ledger = runsLedger(root, "deployment");
    const a = gate();
    _setLedgerSeamsForTest({ lockOptions: noWarn, afterClaim: a.hold });
    const writerA = appendClaim(ledger, {
      claim: "gen/d/1",
      record: { id: "d", state: "prepared", gen: 1 },
    });
    await a.reached;
    _setLedgerSeamsForTest({ lockOptions: STEAL });
    await appendClaim(ledger, { claim: "gen/d/1", record: { id: "d", state: "prepared", gen: 1 } });
    a.open();
    await writerA;
    expect(lines(segmentPath(ledger, 1))).toHaveLength(2);
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.records).toBe(1);
    expect(fold.anomalies).toEqual([]);
    expect(fold.objects.get("d")?.state).toBe("prepared");
  });

  test("with no machine the last row wins, and a row without a state still folds", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    append(ledger, { id: "a", state: "one" });
    append(ledger, { id: "a", state: "two" });
    append(ledger, { id: "b" });
    append(ledger, { note: "no id" });
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.objects.get("a")?.state).toBe("two");
    expect(fold.objects.get("b")?.state).toBeUndefined();
    expect(fold.records).toBe(4);
    expect(fold.anomalies).toEqual([]);
  });

  test("it reads every retained segment and reports malformed lines", async () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = runsLedger(root);
    for (const n of [1, 2, 3]) append(ledger, { id: `x${n}`, state: "s" });
    plant(segmentPath(ledger, 2), `${jsonLine({ id: "x2", state: "s" })}garbage\n`);
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect([...fold.objects.keys()]).toEqual(["x1", "x2", "x3"]);
    expect(fold.gaps).toEqual([expect.objectContaining({ seg: 2, reason: "unreadable" })]);
    await dropSegmentsBefore(ledger, 2);
    const later = foldStates(ledger);
    if (!later.ok) throw new Error(later.reason);
    expect([...later.objects.keys()]).toEqual(["x2", "x3"]);
  });

  test("it is uncapped: a fold sees past any view's window", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const text = "x".repeat(70_000);
    plant(
      segmentPath(ledger, 1),
      `${jsonLine({ id: "first", text })}${jsonLine({ id: "second", text })}`,
    );
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.objects.size).toBe(2);
  });

  test("an absent ledger folds to nothing", () => {
    const fold = foldStates(runsLedger(tempDir()));
    expect(fold).toMatchObject({ ok: true, records: 0 });
  });
});

describe("the run-row bound", () => {
  // `{"p":"` plus `"}` plus the newline is nine bytes.
  const row = (bytes: number) => ({ p: "x".repeat(bytes - 9) });

  test("a 4,096-byte line is refused with `too-large`, nothing appended", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(Buffer.byteLength(jsonLine(row(4096)))).toBe(4096);
    expect(append(ledger, row(4096))).toMatchObject({ ok: false, code: "too-large" });
    expect(existsSync(join(root, ".crewhaus"))).toBe(false);
  });

  test("a 4,095-byte line lands", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(append(ledger, row(4095))).toEqual({ ok: true, seg: 1 });
    expect(statSync(segmentPath(ledger, 1)).size).toBe(4095);
  });

  test("the bound counts bytes, not characters", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    expect(append(ledger, { p: "é".repeat(2044) })).toMatchObject({ ok: false, code: "too-large" });
  });

  test("a new segment is owner-only", () => {
    if (process.platform === "win32") return; // no POSIX mode bits
    const root = tempDir();
    const ledger = runsLedger(root);
    append(ledger, { n: 1 });
    expect(statSync(segmentPath(ledger, 1)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, ledger.records.dir as string)).mode & 0o777).toBe(0o700);
  });
});

describe("torn-line sealing", () => {
  test("a locked append leaves the torn bytes as one gap and the new record intact", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const head = jsonLine({ id: "a" });
    const torn = '{"id":"to';
    plant(segmentPath(ledger, 1), `${head}${torn}`);
    const written = await withLedgerLock(ledger, (lockedAppend) => lockedAppend({ id: "b" }));
    expect(written).toEqual({ ok: true, seg: 1 });
    const read = readTail(root, join(ledger.records.dir as string, "000001.jsonl"), CAPS);
    expect(read).toEqual({
      state: "read",
      records: [{ id: "a" }, { id: "b" }],
      truncated: false,
      gaps: [{ off: head.length, bytes: torn.length + 1, reason: "unreadable" }],
      torn: false,
    });
  });

  test("a locked append to a clean file adds no blank line", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    append(ledger, { id: "a" });
    await withLedgerLock(ledger, (lockedAppend) => lockedAppend({ id: "b" }));
    expect(readFileSync(segmentPath(ledger, 1), "utf8")).toBe(
      `${jsonLine({ id: "a" })}${jsonLine({ id: "b" })}`,
    );
  });

  test("a lock-free append reads nothing, and joins a torn line into one malformed line", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const head = jsonLine({ id: "a" });
    plant(segmentPath(ledger, 1), `${head}{"id":"to`);
    let reads = 0;
    let opens = 0;
    _setIoTapForTest({
      read: () => {
        reads += 1;
      },
      open: () => {
        opens += 1;
      },
    });
    expect(append(ledger, { id: "b" })).toEqual({ ok: true, seg: 1 });
    expect({ reads, opens }).toEqual({ reads: 0, opens: 0 });
    _setIoTapForTest(undefined);
    const read = readTail(root, join(ledger.records.dir as string, "000001.jsonl"), CAPS);
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records).toEqual([{ id: "a" }]);
    expect(read.gaps).toHaveLength(1);
    expect(read.gaps[0]?.off).toBe(head.length);
  });

  test("a seal that meets a line still landing adds only a blank line, which readers skip", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    // The torn part of a line that then completes: what a seal can race with.
    plant(segmentPath(ledger, 1), `${jsonLine({ id: "a" })}\n${jsonLine({ id: "b" })}`);
    const read = readTail(root, join(ledger.records.dir as string, "000001.jsonl"), CAPS);
    expect(read).toMatchObject({ records: [{ id: "a" }, { id: "b" }], gaps: [], torn: false });
  });

  test("appendClaim seals too", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    plant(segmentPath(ledger, 1), '{"id":"to');
    await appendClaim(ledger, { claim: "idem/one", record: { id: "b" } });
    const fold = foldStates(ledger);
    expect(fold).toMatchObject({ ok: true, records: 1 });
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.gaps).toHaveLength(1);
  });

  test("casAppend seals too", async () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    plant(segmentPath(ledger, 1), '{"id":"to');
    await casAppend(ledger, "b", null, { state: "s" });
    const fold = foldStates(ledger);
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.objects.get("b")?.state).toBe("s");
  });
});
