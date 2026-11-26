/**
 * A harness's budget events come only from its period's ledger lines: one
 * `budget.exhausted` for the settle that reaches the limit, `budget.unpriced` for a call
 * nothing could price, `budget.renewed` for the first line of a period that follows
 * another, the same events once on a replay from any cursor, and nothing at all from a
 * read. Events are read through the stream, never waited for by time.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { mintRunId } from "@crewhaus/control-contract";
import { append, resume, runsLedger, snapshotAt } from "@crewhaus/control-records";
import { budgetLedger, periodOf } from "@crewhaus/control-records/budget";
import { bearer } from "../__test__/browser";
import { type V1Home, v1Home } from "../__test__/v1-home";
import {
  BUDGET_EVENT_CAPS,
  BUDGET_STREAM_SOURCE,
  _budgetFoldReadsForTest,
  budgetLineEvent,
  budgetStreamSource,
} from "./budget-stream";

const DAY = 86_400_000;
const MONTH = "budget:\n  usd: 5\n  period: {every: month, usd: 1}";
const DAILY = "budget:\n  usd: 5\n  period: {every: day, usd: 1}";
const CAP = 1_000_000;

let home: V1Home;

beforeAll(async () => {
  home = await v1Home({ streamTimings: { pollMs: 10, heartbeatMs: 60_000 } });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

let clock: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  clock?.mockRestore();
  clock = undefined;
});

/**
 * A run row written after the budget lines: once its frame is read, every line written
 * before it has been read too, so the wait ends on what was written, not on a timer.
 */
function sentinel(dir: string): string {
  const id = mintRunId();
  const written = append(runsLedger(dir), {
    id,
    state: "queued",
    at: new Date().toISOString(),
    trigger: { kind: "api" },
  });
  if (!written.ok) throw new Error(written.reason);
  return id;
}

const reached = (run: string) => (frames: Frame[]) => frames.some((f) => f.data["run"] === run);

let seq = 0;
/** One ledger line of the period current at `atMs`. */
function line(dir: string, atMs: number, every: "month" | "day", fields: Record<string, unknown>) {
  seq += 1;
  const periodId = periodOf({ every, usdMicros: CAP }, atMs).periodId;
  const written = append(budgetLedger(dir, periodId), {
    v: 1,
    at: new Date(atMs + seq).toISOString(),
    id: `res_${seq.toString(16).padStart(8, "0")}`,
    ...fields,
  });
  if (!written.ok) throw new Error(written.reason);
}

/** One ledger line written to the folder of `periodId`, stamped `atMs`. */
function lineIn(dir: string, periodId: string, atMs: number, fields: Record<string, unknown>) {
  seq += 1;
  const record = {
    v: 1,
    at: new Date(atMs + seq).toISOString(),
    id: `res_${seq.toString(16).padStart(8, "0")}`,
    ...fields,
  };
  const written = append(budgetLedger(dir, periodId), record);
  if (!written.ok) throw new Error(written.reason);
  return record;
}

/** Every event a stream of this period sends from `from`, as the stream reads its lines. */
function eventsFrom(
  dir: string,
  harness: string,
  nowMs: number,
  from?: ReturnType<typeof snapshotAt>,
) {
  const source = budgetStreamSource(dir, nowMs);
  const read = resume({ budget: source }, from, { maxLines: 30_000, maxBytes: 16 * 1024 * 1024 });
  return read.items.flatMap((item) => {
    if (item.kind !== "line") return [];
    const event = budgetLineEvent(item.record, harness, dir, source);
    return event === undefined ? [] : [event.type];
  });
}

/** Every file under a directory with its bytes' digest: what "nothing changed" compares. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

type Frame = { readonly event: string; readonly data: Record<string, unknown> };

/** A harness's stream, read frame by frame until a frame says what to stop at. */
async function stream(id: string) {
  const controller = new AbortController();
  const res = await fetch(`${home.t.base}/api/v1/harnesses/${id}/events`, {
    headers: bearer(home.session),
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const frames = (): Frame[] =>
    text
      .split("\n\n")
      .map((block) => {
        let event = "";
        let data: Record<string, unknown> | undefined;
        for (const row of block.split("\n")) {
          if (row.startsWith("event: ")) event = row.slice(7);
          else if (row.startsWith("data: ")) data = JSON.parse(row.slice(6));
        }
        return { event, data };
      })
      .filter((f): f is Frame => f.event !== "" && f.data !== undefined);
  // The first batch: the stream is open from now.
  const first = await reader.read();
  text += decoder.decode(first.value, { stream: true });
  return {
    frames,
    async until(predicate: (frames: Frame[]) => boolean): Promise<Frame[]> {
      while (!predicate(frames())) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return frames();
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

const budgetFrames = (frames: Frame[]) => frames.filter((f) => f.event.startsWith("budget."));

describe("the budget events of one period", () => {
  test("the settle that reaches the limit is one budget.exhausted; a replay sends it once", async () => {
    const h = await home.harness("budget-cap", { specExtra: MONTH });
    const now = Date.now();
    const opening = snapshotAt({ budget: budgetStreamSource(h.dir, now) });
    line(h.dir, now, "month", { op: "reserve", usdMicros: 600_000 });
    line(h.dir, now, "month", { op: "settle", usdMicros: 600_000 });
    line(h.dir, now, "month", { op: "settle", usdMicros: 500_000 });
    line(h.dir, now, "month", { op: "settle", usdMicros: 100_000 });
    line(h.dir, now, "month", { op: "settle", usdMicros: null, unpriced: true });
    const sent = eventsFrom(h.dir, h.id, now, opening);
    expect(sent).toEqual(["budget.exhausted", "budget.unpriced"]);
    // Again from the same cursor, and again from the start: the same events, once each.
    expect(eventsFrom(h.dir, h.id, now, opening)).toEqual(sent);
    expect(eventsFrom(h.dir, h.id, now)).toEqual(sent);
  });

  test("a raise moves the limit: a settle under the raised limit is no exhaustion", async () => {
    const h = await home.harness("budget-raised", { specExtra: MONTH });
    const now = Date.now();
    line(h.dir, now, "month", { op: "settle", usdMicros: 900_000 });
    line(h.dir, now, "month", { op: "topup", usdMicros: 1_000_000, reasonCode: "incident" });
    line(h.dir, now, "month", { op: "settle", usdMicros: 500_000 });
    line(h.dir, now, "month", { op: "settle", usdMicros: 700_000 });
    expect(eventsFrom(h.dir, h.id, now)).toEqual(["budget.extended", "budget.exhausted"]);
  });

  test("on the harness's stream: one budget.exhausted, and a read adds no frame and writes nothing", async () => {
    const h = await home.harness("budget-live", { specExtra: MONTH });
    const feed = await stream(h.id);
    try {
      const now = Date.now();
      line(h.dir, now, "month", { op: "settle", usdMicros: 700_000 });
      line(h.dir, now, "month", { op: "settle", usdMicros: 400_000 });
      line(h.dir, now, "month", { op: "settle", usdMicros: 50_000 });
      line(h.dir, now, "month", { op: "settle", usdMicros: null, unpriced: true });
      const seen = await feed.until(reached(sentinel(h.dir)));
      expect(budgetFrames(seen).map((f) => f.event)).toEqual([
        "budget.exhausted",
        "budget.unpriced",
      ]);
      const exhausted = budgetFrames(seen)[0]?.data ?? {};
      expect(exhausted["harness"]).toBe(h.id);
      expect(exhausted["sensitivity"]).toBe("internal");
      expect(JSON.stringify(exhausted["payload"])).not.toContain("usdMicros");
      // Reads: nothing written, and no frame before the next line.
      const before = tree(h.dir);
      for (const path of [
        `/api/v1/harnesses/${h.id}/budget`,
        "/api/v1/spend",
        "/api/v1/home/status",
      ]) {
        expect((await home.call("GET", path)).status).toBe(200);
      }
      expect(tree(h.dir)).toEqual(before);
      line(h.dir, Date.now(), "month", { op: "settle", usdMicros: null, unpriced: true });
      const after = await feed.until(reached(sentinel(h.dir)));
      expect(budgetFrames(after).map((f) => f.event)).toEqual([
        "budget.exhausted",
        "budget.unpriced",
        "budget.unpriced",
      ]);
    } finally {
      await feed.close();
    }
  }, 20_000); // a stream over a booted Home; slow on a loaded runner

  test("a stream opened in a new period sends budget.renewed for its first line, and only for it", async () => {
    const h = await home.harness("budget-renewed", { specExtra: DAILY });
    // Noon of a day, so the day's lines and the stream's period are one.
    const noon = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
    line(h.dir, noon - DAY, "day", { op: "settle", usdMicros: 100 });
    const real = Date.now.bind(Date);
    const offset = noon - real();
    clock = spyOn(Date, "now").mockImplementation(() => real() + offset);
    const feed = await stream(h.id);
    try {
      line(h.dir, noon, "day", { op: "reserve", usdMicros: 100 });
      line(h.dir, noon, "day", { op: "settle", usdMicros: 100 });
      line(h.dir, noon, "day", { op: "settle", usdMicros: null, unpriced: true });
      const seen = await feed.until(reached(sentinel(h.dir)));
      expect(budgetFrames(seen).map((f) => f.event)).toEqual(["budget.renewed", "budget.unpriced"]);
      const renewed = budgetFrames(seen)[0]?.data["payload"] as Record<string, unknown>;
      expect(renewed["periodId"]).toBe(periodOf({ every: "day", usdMicros: CAP }, noon).periodId);
    } finally {
      await feed.close();
    }
    // The harness's first period ever renews nothing.
    expect(eventsFrom(h.dir, h.id, noon - DAY)).toEqual([]);
  }, 20_000); // a stream over a booted Home; slow on a loaded runner

  test("a harness with no period streams from a folder inside it that holds nothing", () => {
    const sample = join("/", "sample-harness");
    const source = BUDGET_STREAM_SOURCE.source(sample);
    expect(source.root).toBe(sample);
    const records = "dir" in source.records ? source.records.dir : source.records.file;
    expect(records.startsWith("..")).toBe(false);
    expect(records).toContain("no-period");
  });
});

/** The fold reads made since `from`, and the lines they read. */
function since(from: { reads: number; lines: number }) {
  const now = _budgetFoldReadsForTest();
  return { reads: now.reads - from.reads, lines: now.lines - from.lines };
}

describe("judging a period's lines", () => {
  test("a settle lands in its reservation's period, whatever its time says, and is judged there", async () => {
    const h = await home.harness("budget-late-settle", { specExtra: DAILY });
    const noon = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
    const period = periodOf({ every: "day", usdMicros: CAP }, noon).periodId;
    lineIn(h.dir, period, noon, { op: "reserve", usdMicros: 1_200_000 });
    // Settled just after the day renewed: its time is the next day's, its folder this one.
    lineIn(h.dir, period, noon + DAY, { op: "settle", usdMicros: 1_200_000 });
    expect(eventsFrom(h.dir, h.id, noon)).toEqual(["budget.exhausted"]);
  });

  test("each line is read once, however many lines are judged", async () => {
    const h = await home.harness("budget-incremental", { specExtra: MONTH });
    const now = Date.now();
    const source = budgetStreamSource(h.dir, now);
    const period = periodOf({ every: "month", usdMicros: CAP }, now).periodId;
    const judged: string[] = [];
    const start = _budgetFoldReadsForTest();
    const written: Record<string, unknown>[] = [];
    for (let i = 0; i < 40; i += 1) {
      const record = lineIn(h.dir, period, now, { op: "settle", usdMicros: 30_000 });
      written.push(record);
      const event = budgetLineEvent(record, h.id, h.dir, source);
      if (event !== undefined) judged.push(event.type);
    }
    const appended = since(start);
    // One read per new line at most, each from where the last one stopped.
    expect(appended.reads).toBeLessThanOrEqual(40);
    expect(appended.lines).toBe(40);
    // The 34th settle of $0.03 is the one that reaches $1.
    expect(judged).toEqual(["budget.exhausted"]);
    // Judging them all again reads nothing.
    const again = _budgetFoldReadsForTest();
    for (const record of written) budgetLineEvent(record, h.id, h.dir, source);
    expect(since(again)).toEqual({ reads: 0, lines: 0 });
  });

  test("past the caps a line is judged without reading the period again", async () => {
    const h = await home.harness("budget-capped", { specExtra: MONTH });
    const now = Date.now();
    const source = budgetStreamSource(h.dir, now);
    const period = periodOf({ every: "month", usdMicros: CAP }, now).periodId;
    const first = lineIn(h.dir, period, now, { op: "reserve", usdMicros: 1 });
    const folder = budgetLedger(h.dir, period).records;
    if (!("dir" in folder)) throw new Error("a period's ledger is a folder of segments");
    const segment = join(h.dir, folder.dir, readdirSync(join(h.dir, folder.dir))[0] ?? "");
    const filler = `${JSON.stringify({ v: 1, at: new Date(now).toISOString(), op: "reserve", usdMicros: 1 })}\n`;
    appendFileSync(segment, filler.repeat(BUDGET_EVENT_CAPS.maxLines));
    const late = [0, 1, 2, 3, 4].map(() =>
      lineIn(h.dir, period, now, { op: "settle", usdMicros: 2 * CAP }),
    );
    expect(budgetLineEvent(first, h.id, h.dir, source)).toBeUndefined();
    const before = _budgetFoldReadsForTest();
    for (const record of late) expect(budgetLineEvent(record, h.id, h.dir, source)).toBeUndefined();
    expect(since(before).reads).toBe(0);
  }, 20_000); // folds a period of twenty thousand lines once; slow on a loaded runner
});
