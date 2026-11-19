/**
 * An operator's wake: the reason and author come from the session log's marker, the
 * last unscoped synthetic message of the lane before the run's stamp with no other
 * stamp between them, and never from the stamp. No marker reads "reason not recorded".
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  LogBuilder,
  NOW,
  SESSION,
  harnessWith,
  removeFixtures,
  runId,
  simpleRun,
  spanId,
} from "./__fixtures__/build";
import {
  type LoadedRun,
  WAKE_LOOK_BEHIND_BYTES,
  type WhyRecord,
  foldSummary,
  foldTimeline,
  foldWhy,
  loadRun,
  loadedRunFromText,
  terminalSafe,
} from "./index";

afterAll(removeFixtures);

const HEARTBEAT = { kind: "heartbeat", lane: "heartbeat", synthetic: true } as const;

function marker(b: LogBuilder, reason: string, by: string, lane = "heartbeat"): number {
  return b.add("user_message", {
    content: `[crewhaus.control.v1 wake] lane=${lane} reason=${reason}`,
    synthetic: true,
    control: { protocol: "crewhaus.control.v1", lane, synthetic: true, reason, by },
  });
}

function fromText(text: string, run: string): LoadedRun {
  const got = loadedRunFromText(text, { now: NOW, session: SESSION, run });
  if (!got.ok) throw new Error(got.message);
  return got;
}

function why(run: LoadedRun, action: string): WhyRecord {
  const got = foldWhy(run, action);
  if ("ok" in got) throw new Error(got.message);
  return got;
}

describe("operator wake", () => {
  test("a marker, then a synthetic heartbeat stamp: the Why line names the reason and who poked it", () => {
    const b = new LogBuilder();
    marker(b, "retry after fix", "max");
    const run = runId(1);
    const spans = simpleRun(b, run, 0x100, { trigger: HEARTBEAT });
    const loaded = fromText(b.text(), run);
    const summary = foldSummary(loaded);
    expect(summary.wake).toMatchObject({
      state: "reconstructed",
      rule: "synthetic-marker-by-position",
      value: {
        reason: "retry after fix",
        by: "max",
        words: "operator wake: retry after fix (by max)",
      },
    });
    expect(why(loaded, `tool:${spans.tool}`).started.value?.wake?.words).toBe(
      "operator wake: retry after fix (by max)",
    );
    // The marker is not what was asked.
    expect(summary.asked.value).toBe("please read the notes");
  });

  test("of two markers on the lane before one stamp, the last one names the wake", () => {
    const b = new LogBuilder();
    marker(b, "first poke", "alice");
    marker(b, "second poke", "max");
    const run = runId(1);
    simpleRun(b, run, 0x100, { trigger: HEARTBEAT });
    const loaded = fromText(b.text(), run);
    const summary = foldSummary(loaded);
    expect(summary.wake?.value).toMatchObject({ reason: "second poke", by: "max" });
    expect(JSON.stringify(summary)).not.toContain("first poke");
    expect(JSON.stringify(summary)).not.toContain("alice");
  });

  test("the same stamp with no marker reads 'reason not recorded', and does not fail", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const spans = simpleRun(b, run, 0x100, { trigger: HEARTBEAT });
    const loaded = fromText(b.text(), run);
    expect(foldSummary(loaded).wake).toMatchObject({
      state: "not-recorded",
      gap: { reason: "not-recorded" },
      value: { words: "operator wake (reason not recorded)" },
    });
    expect(why(loaded, `tool:${spans.tool}`).started.value?.wake?.words).toBe(
      "operator wake (reason not recorded)",
    );
  });

  test("a heartbeat run that is not synthetic is never given an earlier tick's marker", () => {
    const b = new LogBuilder();
    marker(b, "earlier poke", "max");
    simpleRun(b, runId(1), 0x100, { trigger: HEARTBEAT });
    const organic = runId(2);
    simpleRun(b, organic, 0x200, { trigger: { kind: "heartbeat", lane: "heartbeat" } });
    const loaded = fromText(b.text(), organic);
    const summary = foldSummary(loaded);
    expect(summary.wake).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain("earlier poke");
    expect(JSON.stringify(foldTimeline(loaded, { view: "full" }))).not.toContain("earlier poke");
  });

  test("of two synthetic runs, the second without its marker reads 'reason not recorded'", () => {
    const b = new LogBuilder();
    marker(b, "first poke", "max");
    simpleRun(b, runId(1), 0x100, { trigger: HEARTBEAT });
    const second = runId(2);
    simpleRun(b, second, 0x200, { trigger: HEARTBEAT });
    const summary = foldSummary(fromText(b.text(), second));
    expect(summary.wake?.value?.words).toBe("operator wake (reason not recorded)");
    expect(JSON.stringify(summary)).not.toContain("first poke");
    // A marker on another lane is not this run's either.
    const c = new LogBuilder();
    marker(c, "other lane", "max", "schedule");
    simpleRun(c, runId(3), 0x300, { trigger: HEARTBEAT });
    expect(foldSummary(fromText(c.text(), runId(3))).wake?.value?.words).toBe(
      "operator wake (reason not recorded)",
    );
  });

  test("read by its run id from sessionAt, the marker before it is still found, and the look-behind stops at the previous stamp", () => {
    const b = new LogBuilder();
    // An earlier run, with plenty of lines before its stamp, so a look-behind that did
    // not stop at the stamp would read them.
    for (let i = 0; i < 400; i++)
      b.add("tool_stats", { toolName: "Read", durationMs: i, isError: false });
    const previousStamp = b.stamp(runId(1), spanId(0x101));
    b.add("user_message", { content: "earlier ask" }, { run: runId(1), span: spanId(0x101) });
    b.close(runId(1), spanId(0x101), "run");
    marker(b, "\u001b[2Jclear the screen", "ops\u009b2J");
    // As the real writers order it: the marker is written before the loop starts, so the
    // run's sessionAt is the marker line's end.
    const sessionAt = b.size;
    const run = runId(2);
    simpleRun(b, run, 0x200, { trigger: HEARTBEAT });
    const { dir } = harnessWith({
      log: b.text(),
      rows: [{ id: run, state: "succeeded", trigger: HEARTBEAT, session: SESSION, sessionAt }],
    });
    const reads: Array<[number, number]> = [];
    const answer = loadRun({
      harnessDir: dir,
      ref: run,
      envVars: {},
      now: NOW,
      onRead: (position, length) => reads.push([position, length]),
    });
    if (!answer.ok) throw new Error(answer.message);
    const summary = foldSummary(answer);
    expect(summary.wake?.state).toBe("reconstructed");
    expect(summary.wake?.value?.reason).toBe("\u001b[2Jclear the screen");
    const below = reads.filter(([position]) => position < sessionAt);
    expect(below.length).toBeGreaterThan(0);
    // Stopped at the previous stamp: no read starts a chunk's length or more below it.
    expect(Math.min(...below.map(([position]) => position))).toBeGreaterThan(previousStamp - 4096);
    expect(below.reduce((sum, [, length]) => sum + length, 0)).toBeLessThanOrEqual(
      WAKE_LOOK_BEHIND_BYTES,
    );
    // Printed, the reason and author carry no terminal control characters.
    const printed = terminalSafe(summary.wake?.value?.words ?? "");
    expect(printed).toBe("operator wake: [2Jclear the screen (by ops2J)");
    expect(printed).not.toContain("\u001b");
    expect(printed).not.toContain("\u009b");
    // Nothing else from below the run is attributed to it.
    expect(JSON.stringify(summary)).not.toContain("earlier ask");
  });

  test("the look-behind reads no more than its cap when no stamp stops it", () => {
    const b = new LogBuilder();
    for (let i = 0; i < 2000; i++)
      b.add("tool_stats", { toolName: "Read", durationMs: i, isError: false });
    marker(b, "poke", "max");
    const sessionAt = b.size;
    expect(sessionAt).toBeGreaterThan(WAKE_LOOK_BEHIND_BYTES * 2);
    const run = runId(2);
    simpleRun(b, run, 0x200, { trigger: HEARTBEAT });
    const { dir } = harnessWith({
      log: b.text(),
      rows: [{ id: run, state: "succeeded", trigger: HEARTBEAT, session: SESSION, sessionAt }],
    });
    const reads: Array<[number, number]> = [];
    const answer = loadRun({
      harnessDir: dir,
      ref: run,
      envVars: {},
      now: NOW,
      onRead: (position, length) => reads.push([position, length]),
    });
    if (!answer.ok) throw new Error(answer.message);
    expect(foldSummary(answer).wake?.value?.reason).toBe("poke");
    const below = reads.filter(([position]) => position < sessionAt);
    expect(Math.min(...below.map(([position]) => position))).toBe(
      sessionAt - WAKE_LOOK_BEHIND_BYTES,
    );
    expect(below.reduce((sum, [, length]) => sum + length, 0)).toBe(WAKE_LOOK_BEHIND_BYTES);
  });
});
