/**
 * What is missing is named, never dropped: a fixture for each reason these folds
 * produce, and a session written before run records as one run whose turns are pieced
 * together.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  type ContextUsed,
  GAPS_PRODUCED_ELSEWHERE,
  INSPECT_GAP_REASONS,
  type InspectGapReason,
  type LoadedRun,
  type TimelinePage,
  foldContext,
  foldSpanTree,
  foldSummary,
  foldTimeline,
  foldWhy,
  loadRun,
  loadedRunFromText,
} from "./index";

afterAll(removeFixtures);

function fromText(text: string, run?: string): LoadedRun {
  const got = loadedRunFromText(text, {
    now: NOW,
    session: SESSION,
    ...(run !== undefined ? { run } : {}),
  });
  if (!got.ok) throw new Error(got.message);
  return got;
}

function load(dir: string, ref: string, maxBytes?: number): LoadedRun {
  const got = loadRun({
    harnessDir: dir,
    ref,
    envVars: {},
    now: NOW,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
  if (!got.ok) throw new Error(got.message);
  return got;
}

/** A pre-0.9 session: messages and tools, no run stamps, no spans. */
function legacyLog(): string {
  const b = new LogBuilder();
  b.add("user_message", { content: "first question" });
  b.add("assistant_message", { content: [{ type: "text", text: "first answer" }] });
  b.add("user_message", { content: "second question" });
  b.add("assistant_message", {
    content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "a" } }],
  });
  b.add("tool_use", { id: "tu_1", name: "Read", input: { path: "a" } });
  b.add("user_message", { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "x" }] });
  b.add("tool_result", { toolUseId: "tu_1", content: "file a", isError: false });
  b.add("assistant_message", { content: [{ type: "text", text: "second answer" }] });
  return b.text();
}

const produced = new Set<InspectGapReason>();
function sawGap(reasons: Iterable<InspectGapReason>): void {
  for (const reason of reasons) produced.add(reason);
}

describe("each gap reason has a fixture", () => {
  test("before-0.9: a session with no run records reads as one run, its turns pieced together", () => {
    const loaded = fromText(legacyLog());
    expect(loaded.subject).toEqual({ kind: "legacy", session: SESSION });
    const summary = foldSummary(loaded);
    const gap = summary.gaps.find((g) => g.reason === "before-0.9");
    expect(gap).toEqual({ reason: "before-0.9", remedy: "crewhaus compile" });
    sawGap(summary.gaps.map((g) => g.reason));
    expect(summary.asked.value).toBe("first question");
    expect(summary.outcome.value).toBe("second answer");
    const page = foldTimeline(loaded, { view: "full" }) as TimelinePage;
    const tool = page.entries.find((e) => e.kind === "tool");
    expect(tool?.turn).toEqual({
      state: "reconstructed",
      value: 2,
      rule: "legacy-turn-by-user-message",
      refs: [tool?.id],
    });
    expect(tool?.detail).toBe("file a");
    const first = page.entries.find((e) => e.kind === "answer" && e.detail === "first answer");
    expect(first?.turn?.value).toBe(1);
    expect(foldContext(loaded, 1)).toMatchObject({
      ok: false,
      code: "unsupported",
      verb: "crewhaus compile",
    });
    expect(foldWhy(loaded, "tool:0000000000000001")).toMatchObject({
      ok: false,
      code: "unsupported",
      verb: "crewhaus compile",
    });
  });

  test("records-off: rows but no stamps; the run's lines are those between its row's sessionAt and the next run's", () => {
    const b = new LogBuilder();
    b.add("user_message", { content: "run one ask" });
    b.add("assistant_message", { content: [{ type: "text", text: "run one answer" }] });
    const second = b.size;
    b.add("user_message", { content: "run two ask" });
    b.add("assistant_message", { content: [{ type: "text", text: "run two answer" }] });
    const [one, two] = [runId(1), runId(2)];
    const { dir } = harnessWith({
      log: b.text(),
      rows: [
        { id: one, state: "running", trigger: { kind: "cli" }, session: SESSION, sessionAt: 0 },
        { id: one, state: "succeeded", trigger: { kind: "cli" } },
        {
          id: two,
          state: "running",
          trigger: { kind: "cli" },
          session: SESSION,
          sessionAt: second,
        },
      ],
    });
    const loaded = load(dir, one);
    expect(loaded.mode).toBe("records-off");
    const summary = foldSummary(loaded);
    expect(summary.gaps).toContainEqual({ reason: "records-off", remedy: "CREWHAUS_RUN_STAMPS" });
    sawGap(summary.gaps.map((g) => g.reason));
    expect(summary.asked).toEqual({
      state: "reconstructed",
      value: "run one ask",
      rule: "records-off-by-run-row",
      refs: ["s:0"],
    });
    expect(summary.outcome.value).toBe("run one answer");
    expect(summary.status).toMatchObject({ state: "recorded", value: { word: "Finished" } });
    expect(JSON.stringify(summary)).not.toContain("run two");
  });

  test("advisor-off, cost-off and not-supervised come from the stamp's recording flags", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100, { recording: { advisorEvents: false, costTracking: false } });
    const summary = foldSummary(fromText(b.text(), run));
    expect(summary.gaps).toContainEqual({
      reason: "advisor-off",
      remedy: "CREWHAUS_ADVISOR_EVENTS",
    });
    expect(summary.gaps).toContainEqual({ reason: "cost-off", remedy: "CREWHAUS_COST_TRACKING" });
    expect(summary.gaps).toContainEqual({
      reason: "not-supervised",
      remedy: "crewhaus daemon start",
    });
    expect(summary.execution).toMatchObject({
      state: "not-recorded",
      gap: { reason: "not-supervised" },
    });
    sawGap(summary.gaps.map((g) => g.reason));
    // A supervised run names where its trace events are.
    const c = new LogBuilder();
    simpleRun(c, run, 0x100, { execution: "run_0123456789abcdef" });
    const supervised = foldSummary(fromText(c.text(), run));
    expect(supervised.execution).toMatchObject({
      state: "recorded",
      value: { id: "run_0123456789abcdef" },
    });
    expect(supervised.gaps.some((g) => g.reason === "not-supervised")).toBe(false);
  });

  test("evicted: run rows name a session whose log is gone", () => {
    const run = runId(1);
    const { dir, sessions } = harnessWith({
      log: "",
      rows: [
        { id: run, state: "succeeded", trigger: { kind: "cli" }, session: SESSION, sessionAt: 0 },
      ],
    });
    rmSync(join(sessions, `${SESSION}.jsonl`));
    const summary = foldSummary(load(dir, run));
    expect(summary.gaps).toContainEqual({ reason: "evicted" });
    expect(summary.status.value?.word).toBe("Finished");
    sawGap(summary.gaps.map((g) => g.reason));
  });

  test("truncated and torn: a size limit and a damaged line each become a gap, and reading goes on past the damage", () => {
    const b = new LogBuilder();
    const run = runId(1);
    b.stamp(run, "0000000000000101");
    const torn = b.raw("{ this line is torn\n");
    b.add("user_message", { content: "after the damage" }, { run, span: "0000000000000101" });
    const cut = b.size;
    b.add("assistant_message", { content: [{ type: "text", text: "x".repeat(500) }] }, { run });
    const { dir } = harnessWith({ log: b.text() });
    const loaded = load(dir, SESSION, cut + 10);
    const summary = foldSummary(loaded);
    expect(summary.gaps).toContainEqual({ reason: "torn", from: `s:${torn}`, count: 1 });
    expect(summary.gaps).toContainEqual({
      reason: "truncated",
      from: `s:${cut}`,
      to: `s:${b.size}`,
    });
    expect(summary.asked.value).toBe("after the damage");
    const page = foldTimeline(loaded, { view: "full" }) as TimelinePage;
    expect(page.truncated).toBe(true);
    expect(page.entries.map((e) => e.title)).toContain("A damaged line was skipped");
    sawGap(summary.gaps.map((g) => g.reason));
    // An incomplete last line is damage too, not a silent drop.
    const partial = fromText(`${b.text()}{"ts":1,"kind":"user_mess`, run);
    expect(partial.gaps.some((g) => g.reason === "torn" && g.from === `s:${b.size}`)).toBe(true);
  });

  test("unfinished, not-recorded and unsupported", () => {
    const b = new LogBuilder();
    const run = runId(1);
    b.stamp(run, "0000000000000101");
    b.add("tool_use", { id: "tu_1", name: "Bash", input: {} }, { run, span: "0000000000000102" });
    const loaded = fromText(b.text(), run);
    sawGap(foldSpanTree(loaded).gaps.map((g) => g.reason));
    expect(produced.has("unfinished")).toBe(true);
    // The model's choice of tool is never recorded by a provider.
    const c = new LogBuilder();
    const spans = simpleRun(c, run, 0x100);
    const full = fromText(c.text(), run);
    const why = foldWhy(full, `tool:${spans.tool}`);
    if ("ok" in why) throw new Error(why.message);
    expect(why.options.value?.toolChoice).toEqual({
      state: "not-recorded",
      refs: [],
      gap: { reason: "not-recorded" },
    });
    sawGap([why.options.value?.toolChoice.gap?.reason as InspectGapReason]);
    // Whether what a call used has changed since needs a lookup none is given here.
    const context = foldContext(full, 1) as ContextUsed;
    expect(context.changedSince).toEqual({
      state: "not-recorded",
      refs: [],
      gap: { reason: "unsupported" },
    });
    sawGap([context.changedSince.gap?.reason as InspectGapReason]);
  });

  test("pruned: the run names a supervised execution whose events retention removed", () => {
    const run = runId(1);
    const exec = "run_00000000000000e1";
    const b = new LogBuilder();
    simpleRun(b, run, 0x100, { execution: exec });
    const { dir } = harnessWith({
      log: b.text(),
      rows: [
        { id: run, state: "succeeded", trigger: { kind: "cli" }, session: SESSION, sessionAt: 0 },
      ],
    });
    // Without a prune record, the missing file is only not recorded.
    expect(foldSummary(load(dir, run)).gaps).toContainEqual({ reason: "not-recorded" });
    mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "run", "pruned.jsonl"),
      `${JSON.stringify({ v: 1, at: "2026-11-14T12:00:00.000Z", runs: [exec] })}\n`,
    );
    const summary = foldSummary(load(dir, run));
    expect(summary.gaps).toContainEqual({ reason: "pruned" });
    expect(summary.gaps.some((g) => g.reason === "not-supervised")).toBe(false);
    expect(summary.trace).toEqual({ present: false, events: 0, truncated: false });
    sawGap(summary.gaps.map((g) => g.reason));
  });

  test("the reasons produced here and those produced elsewhere are the whole vocabulary, and do not overlap", () => {
    const elsewhere = new Set(GAPS_PRODUCED_ELSEWHERE);
    expect([...produced].filter((r) => elsewhere.has(r))).toEqual([]);
    expect([...new Set([...produced, ...elsewhere])].sort()).toEqual(
      [...INSPECT_GAP_REASONS].sort(),
    );
    expect(INSPECT_GAP_REASONS.length).toBe(14);
  });
});
