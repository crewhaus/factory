/**
 * What the folds guarantee before a server serves them: recorded names resolve only to a
 * table's own entries; the session log is opened only as a file proven inside the
 * sessions folder; free text in a fixed line is one line; a wake marker belongs to the
 * run that read it; a run with nothing read is its own case; the run-ledger read is
 * capped and says so; a cost line with no amount is "Cost unknown"; a view is ready for a
 * key-name masker; and the timeline pages after an entry as well as before one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setIoTapForTest, controlPaths } from "@crewhaus/control-records";
import { REDACTED_VALUE, isCredentialKey } from "@crewhaus/spec-patch";
import { _setOpenHooksForTest } from "@crewhaus/tool-safety/fs";
import {
  LogBuilder,
  NOW,
  SESSION,
  harnessWith,
  removeFixtures,
  runId,
  simpleRun,
} from "./__fixtures__/build";
import {
  type LoadedRun,
  type TimelinePage,
  beforeMask,
  foldSummary,
  foldTimeline,
  foldWhy,
  loadRun,
  loadedRunFromText,
} from "./index";

const outsideDirs: string[] = [];
afterAll(() => {
  removeFixtures();
  for (const dir of outsideDirs) rmSync(dir, { recursive: true, force: true });
});

const HEARTBEAT = { kind: "heartbeat", lane: "heartbeat", synthetic: true } as const;

function marker(b: LogBuilder, reason: string, by: string): number {
  return b.add("user_message", {
    content: `[crewhaus.control.v1 wake] lane=heartbeat reason=${reason}`,
    synthetic: true,
    control: { protocol: "crewhaus.control.v1", lane: "heartbeat", synthetic: true, reason, by },
  });
}

function load(dir: string, ref: string, extra: Partial<Parameters<typeof loadRun>[0]> = {}) {
  const got = loadRun({ harnessDir: dir, ref, envVars: {}, now: NOW, ...extra });
  if (!got.ok) throw new Error(got.message);
  return got;
}

function fromText(text: string, run: string): LoadedRun {
  const got = loadedRunFromText(text, { now: NOW, session: SESSION, run });
  if (!got.ok) throw new Error(got.message);
  return got;
}

function full(loaded: LoadedRun): TimelinePage {
  const page = foldTimeline(loaded, { view: "full", limit: 500 });
  if ("ok" in page) throw new Error(page.message);
  return page;
}

describe("recorded names resolve only to a table's own entries", () => {
  test("a session line of kind 'constructor' is an other entry", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const spans = simpleRun(b, run, 0x100);
    b.add("constructor", { x: 1 }, { run, span: spans.root });
    b.add("toString", {}, { run, span: spans.root });
    const page = full(fromText(b.text(), run));
    const odd = page.entries.filter((e) => e.title.startsWith("Recorded: "));
    expect(odd.map((e) => [e.kind, e.group, e.title])).toEqual([
      ["other", "other", "Recorded: toString"],
      ["other", "other", "Recorded: constructor"],
    ]);
  });

  test("a trigger of kind 'toString' gives a string title", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100, { trigger: { kind: "toString" } });
    const summary = foldSummary(fromText(b.text(), run));
    expect(typeof summary.title).toBe("string");
    expect(summary.title).toBe("Started by toString");
    // A check whose gate is named like a built-in property reads as a check.
    const c = new LogBuilder();
    const spans = simpleRun(c, run, 0x100);
    c.add(
      "verdict",
      { v: 1, run, gate: "constructor", outcome: "deny" },
      { run, span: spans.tool },
    );
    const titles = full(fromText(c.text(), run)).entries.map((e) => e.title);
    expect(titles).toContain("Check: deny");
  });
});

describe("the session log is opened only as a file proven inside the sessions folder", () => {
  test("a sessions folder swapped for a link out between the check and the open is refused, and nothing outside is read", () => {
    const b = new LogBuilder();
    simpleRun(b, runId(1), 0x100);
    const { dir, sessions } = harnessWith({ log: b.text() });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "run-inspect-outside-")));
    outsideDirs.push(outside);
    const canary = new LogBuilder();
    simpleRun(canary, runId(2), 0x200, { ask: "CANARY-OUTSIDE" });
    writeFileSync(join(outside, `${SESSION}.jsonl`), canary.text());
    let swapped = 0;
    _setOpenHooksForTest({
      beforeOpen: (real) => {
        if (!real.endsWith(`${SESSION}.jsonl`) || swapped > 0) return;
        swapped += 1;
        renameSync(sessions, `${sessions}.moved`);
        symlinkSync(outside, sessions);
      },
    });
    const reads: Array<[number, number]> = [];
    let answer: ReturnType<typeof loadRun>;
    try {
      answer = loadRun({
        harnessDir: dir,
        ref: SESSION,
        envVars: {},
        now: NOW,
        onRead: (position, length) => reads.push([position, length]),
      });
    } finally {
      _setOpenHooksForTest({});
    }
    expect(swapped).toBe(1);
    expect(answer).toMatchObject({
      ok: false,
      code: "unsupported",
      message: "the session log leads out of the sessions folder",
    });
    expect(reads).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain("CANARY");
  });
});

describe("free text in a fixed line is one line", () => {
  test("a marker reason holding a newline and U+202E is flat in the summary and the timeline", () => {
    const b = new LogBuilder();
    marker(b, "line one\nline two \u202Eevil", "max\u2028ops");
    const run = runId(1);
    simpleRun(b, run, 0x100, { trigger: HEARTBEAT });
    const loaded = fromText(b.text(), run);
    const words = foldSummary(loaded).wake?.value?.words ?? "";
    expect(words).toBe("operator wake: line one line two evil (by max ops)");
    const entries = full(loaded).entries;
    const start = entries.find((e) => e.kind === "run-start");
    const wake = entries.find((e) => e.kind === "operator-wake");
    expect(start?.detail).toBe(words);
    expect(wake?.detail).toBe("line one line two evil (by max ops)");
    for (const text of [words, start?.detail ?? "", wake?.detail ?? ""]) {
      expect(text).not.toMatch(/[\n\u202E\u2028]/);
    }
  });
});

describe("a wake marker belongs to the run that read it", () => {
  test("with run records off, a synthetic second run's reason is never the first run's, and is the second's", () => {
    const b = new LogBuilder();
    b.add("user_message", { content: "run one ask" });
    b.add("assistant_message", { content: [{ type: "text", text: "run one answer" }] });
    marker(b, "second run reason", "max");
    const second = b.size;
    b.add("user_message", { content: "run two ask" });
    b.add("assistant_message", { content: [{ type: "text", text: "run two answer" }] });
    const [one, two] = [runId(1), runId(2)];
    const { dir } = harnessWith({
      log: b.text(),
      rows: [
        { id: one, state: "running", trigger: { kind: "cli" }, session: SESSION, sessionAt: 0 },
        { id: one, state: "succeeded", trigger: { kind: "cli" } },
        { id: two, state: "running", trigger: HEARTBEAT, session: SESSION, sessionAt: second },
        { id: two, state: "succeeded", trigger: HEARTBEAT },
      ],
    });
    const first = load(dir, one);
    expect(first.mode).toBe("records-off");
    const firstSummary = foldSummary(first);
    expect(firstSummary.wake).toBeUndefined();
    expect(JSON.stringify(firstSummary)).not.toContain("second run reason");
    expect(JSON.stringify(full(first))).not.toContain("second run reason");
    expect(JSON.stringify(foldWhy(first, "tool:0000000000000104"))).not.toContain(
      "second run reason",
    );
    const later = load(dir, two);
    const summary = foldSummary(later);
    expect(summary.wake).toMatchObject({
      state: "reconstructed",
      rule: "synthetic-marker-by-position",
      value: { reason: "second run reason", by: "max" },
    });
    const wake = full(later).entries.find((e) => e.kind === "operator-wake");
    expect(wake?.detail).toBe("second run reason (by max)");
    expect(summary.asked.value).toBe("run two ask");
  });

  test("a stamped run never shows another run's marker it holds", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const spans = simpleRun(b, run, 0x100);
    // A marker written while the run was open, for a later run's wake.
    b.add("user_message", {
      content: "x",
      synthetic: true,
      control: { lane: "heartbeat", synthetic: true, reason: "later poke", by: "max" },
    });
    b.add("user_message", { content: "more" }, { run, span: spans.root });
    const text = JSON.stringify(full(fromText(b.text(), run)));
    expect(text).not.toContain("later poke");
  });
});

describe("a run with nothing read", () => {
  test("its gaps say the transcript was removed, never that records were off", () => {
    const run = runId(1);
    const { dir, sessions } = harnessWith({
      log: "",
      rows: [
        { id: run, state: "succeeded", trigger: { kind: "cli" }, session: SESSION, sessionAt: 0 },
      ],
    });
    rmSync(join(sessions, `${SESSION}.jsonl`));
    const loaded = load(dir, run);
    expect(loaded.mode).toBe("unread");
    const reasons = foldSummary(loaded).gaps.map((g) => g.reason);
    expect(reasons).toContain("evicted");
    expect(reasons).not.toContain("records-off");
  });

  test("a run whose lines carry its id but whose stamp is missing keeps those lines", () => {
    const run = runId(1);
    const b = new LogBuilder();
    b.add("user_message", { content: "tagged ask" }, { run });
    b.add("assistant_message", { content: [{ type: "text", text: "tagged answer" }] }, { run });
    const { dir } = harnessWith({
      log: b.text(),
      rows: [
        { id: run, state: "succeeded", trigger: { kind: "cli" }, session: SESSION, sessionAt: 0 },
      ],
    });
    const loaded = load(dir, run);
    expect(loaded.mode).toBe("stamped");
    const details = full(loaded).entries.map((e) => e.detail);
    expect(details).toContain("tagged ask");
    expect(details).toContain("tagged answer");
    expect(foldSummary(loaded).gaps.map((g) => g.reason)).not.toContain("records-off");
  });
});

describe("the run-ledger read is capped and says so", () => {
  /** A harness whose run ledger holds `filler` rows of other runs, then `rows`. */
  function bigLedger(
    filler: number,
    rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
    log: string,
  ) {
    const first = { id: runId(900_000), state: "running", trigger: { kind: "cli" } };
    const { dir } = harnessWith({ log, rows: [first] });
    const runsDir = join(dir, controlPaths(dir).runsDir);
    const segment = readdirSync(runsDir).find((name) => name.endsWith(".jsonl"));
    if (segment === undefined) throw new Error("no ledger segment");
    const lines: string[] = [];
    for (let i = 0; i < filler; i++) {
      lines.push(
        JSON.stringify({
          at: "2026-11-14T11:00:00.000Z",
          id: runId(100_000 + i),
          state: "succeeded",
          trigger: { kind: "cli" },
          session: "sess_00000000000000ff",
          sessionAt: i,
        }),
      );
    }
    for (const row of rows) lines.push(JSON.stringify({ at: "2026-11-14T11:59:00.000Z", ...row }));
    appendFileSync(join(runsDir, segment), `${lines.join("\n")}\n`);
    return dir;
  }

  function counted<T>(fn: () => T): { readonly value: T; readonly bytes: number } {
    let bytes = 0;
    _setIoTapForTest({
      read: (_position, length) => {
        bytes += length;
      },
    });
    try {
      return { value: fn(), bytes };
    } finally {
      _setIoTapForTest(undefined);
    }
  }

  test("past the cap, older rows are left unread, a truncated gap says so, and the reads stop", () => {
    const b = new LogBuilder();
    simpleRun(b, runId(1), 0x100);
    const dir = bigLedger(4000, [], b.text());
    const capped = counted(() => load(dir, SESSION, { ledgerScanMaxRows: 2500 }));
    const whole = counted(() => load(dir, SESSION));
    expect(capped.value.gaps).toContainEqual({ reason: "truncated" });
    expect(whole.value.gaps.some((g) => g.reason === "truncated")).toBe(false);
    expect(capped.bytes).toBeGreaterThan(0);
    expect(capped.bytes).toBeLessThan(whole.bytes * 0.75);
  }, 20_000); // writes and reads thousands of ledger rows

  test("a run named by its id stops reading once its rows and its session's are read", () => {
    const run = runId(1);
    const b = new LogBuilder();
    simpleRun(b, run, 0x100);
    const dir = bigLedger(
      6000,
      [
        { id: run, state: "running", trigger: { kind: "cli" }, session: SESSION, sessionAt: 0 },
        { id: run, state: "succeeded", trigger: { kind: "cli" } },
      ],
      b.text(),
    );
    const byRun = counted(() => load(dir, run));
    const bySession = counted(() => load(dir, SESSION, { run }));
    expect(byRun.value.rows.map((row) => row["state"])).toEqual(["running", "succeeded"]);
    expect(foldSummary(byRun.value).status.value?.word).toBe("Finished");
    expect(byRun.value.gaps.some((g) => g.reason === "truncated")).toBe(false);
    // The newest page holds its rows, the next none of its session's: two pages of seven.
    expect(byRun.bytes).toBeLessThan(bySession.bytes * 0.5);
  }, 20_000); // writes and reads thousands of ledger rows
});

describe("a run read by its id", () => {
  test("a run no wake started reads only bytes from its sessionAt", () => {
    const b = new LogBuilder();
    for (let i = 0; i < 5000; i++) b.add("tool_stats", { toolName: "Read", durationMs: i });
    const sessionAt = b.size;
    const run = runId(7);
    simpleRun(b, run, 0x700);
    const { dir } = harnessWith({
      log: b.text(),
      rows: [
        { id: run, state: "succeeded", trigger: { kind: "cli" }, session: SESSION, sessionAt },
      ],
    });
    const reads: Array<[number, number]> = [];
    const loaded = load(dir, run, { onRead: (position, length) => reads.push([position, length]) });
    expect(foldSummary(loaded).asked.value).toBe("please read the notes");
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.min(...reads.map(([position]) => position))).toBe(sessionAt);
    expect(reads.reduce((sum, [, length]) => sum + length, 0)).toBe(b.size - sessionAt);
  });
});

describe("cost", () => {
  test("a cost line that records no amount makes the cost unknown, never $0", () => {
    const run = runId(1);
    for (const line of [
      { inputTokens: 10, outputTokens: 5 },
      { costUsdMicros: "12", inputTokens: 10 },
      { costUsdMicros: 400 },
    ]) {
      const b = new LogBuilder();
      simpleRun(b, run, 0x100, { cost: [{ costUsdMicros: 400 }, line] });
      const cost = foldSummary(fromText(b.text(), run)).cost;
      if (line.costUsdMicros === 400) {
        expect(cost.value?.usdMicros).toBe(800);
        continue;
      }
      expect(cost).toMatchObject({
        state: "not-recorded",
        gap: { reason: "not-recorded" },
        value: { usdMicros: null, unknown: "not-recorded", words: "Cost unknown" },
      });
    }
  });
});

describe("beforeMask", () => {
  const options = { isSecretName: isCredentialKey, redacted: REDACTED_VALUE };

  test("a JSON text's values under credential names are replaced, and it is written back as JSON", () => {
    const pw = ["pw", "7q1"].join("-");
    const key = ["k", "ab9"].join("");
    const view = {
      entries: [
        { detail: JSON.stringify({ password: pw, nested: [{ api_key: key }], ok: "fine" }) },
      ],
      plain: "not json",
      broken: "{ nope",
    };
    const out = beforeMask(view, options) as {
      entries: [{ detail: string }];
      plain: string;
      broken: string;
    };
    expect(JSON.parse(out.entries[0].detail)).toEqual({
      password: REDACTED_VALUE,
      nested: [{ api_key: REDACTED_VALUE }],
      ok: "fine",
    });
    expect(JSON.stringify(out)).not.toContain(pw);
    expect(JSON.stringify(out)).not.toContain(key);
    expect(out.plain).toBe("not json");
    expect(out.broken).toBe("{ nope");
  });

  test("a value split by a control or a format character is whole again, newlines and tabs kept", () => {
    const out = beforeMask(
      { a: "ab\u0007cd", b: "x\u200By", c: "one\ntwo\tthree", "k\u0000ey": 1 },
      options,
    );
    expect(out).toEqual({ a: "abcd", b: "xy", c: "one\ntwo\tthree", key: 1 });
  });
});

describe("paging after an entry", () => {
  test("after names an entry: only the newer ones, newest first; with before, it is refused", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100);
    const loaded = fromText(b.text(), run);
    const all = full(loaded).entries;
    expect(all.length).toBeGreaterThan(5);
    const anchor = all[4]?.id as string;
    const page = foldTimeline(loaded, { view: "full", after: anchor });
    if ("ok" in page) throw new Error(page.message);
    expect(page.entries.map((e) => e.id)).toEqual(all.slice(0, 4).map((e) => e.id));
    const limited = foldTimeline(loaded, { view: "full", after: anchor, limit: 2 });
    if ("ok" in limited) throw new Error(limited.message);
    expect(limited.entries.map((e) => e.id)).toEqual(all.slice(0, 2).map((e) => e.id));
    expect(foldTimeline(loaded, { after: anchor, before: anchor })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(foldTimeline(loaded, { after: "s:999999" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });
});
