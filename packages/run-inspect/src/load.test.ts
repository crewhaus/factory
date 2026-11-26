/**
 * Reading a run: which lines are the run's, where reading starts, which files are read
 * at all, and a transcript that is not in a harness.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { foldSummary, foldTimeline, loadRun, loadedRunFromText } from "./index";
import type { LoadedRun, TimelinePage } from "./index";

afterAll(removeFixtures);

function loaded(answer: ReturnType<typeof loadRun>): LoadedRun {
  if (!answer.ok) throw new Error(`refused: ${answer.code} ${answer.message}`);
  return answer;
}

function page(answer: ReturnType<typeof foldTimeline>): TimelinePage {
  if ("ok" in answer) throw new Error(`refused: ${answer.message}`);
  return answer;
}

describe("the run's lines", () => {
  test("a run's lines are folded and another run's interleaved lines are not", () => {
    const b = new LogBuilder();
    const [one, two] = [runId(1), runId(2)];
    simpleRun(b, one, 0x100, { ask: "first ask", answer: "first answer" });
    // The second run interleaves its lines with a third run that never stamps the log.
    b.stamp(two, "0000000000000201");
    b.add("user_message", { content: "second ask" }, { run: two, span: "0000000000000201" });
    b.add("user_message", { content: "a foreign ask" }, { run: runId(3) });
    b.add(
      "assistant_message",
      { content: [{ type: "text", text: "foreign answer" }] },
      { run: runId(3) },
    );
    b.add(
      "assistant_message",
      { content: [{ type: "text", text: "second answer" }] },
      { run: two, span: "0000000000000201" },
    );
    const { dir } = harnessWith({ log: b.text() });
    const run = loaded(loadRun({ harnessDir: dir, ref: SESSION, run: two, envVars: {}, now: NOW }));
    const summary = foldSummary(run);
    expect(summary.subject).toEqual({ kind: "run", run: two, session: SESSION });
    expect(summary.asked.value).toBe("second ask");
    expect(summary.outcome.value).toBe("second answer");
    const text = JSON.stringify(page(foldTimeline(run, { view: "full" })));
    expect(text).not.toContain("foreign");
    expect(text).not.toContain("first ask");
  });

  test("a session id lists its runs and picks the newest one no other run started", () => {
    const b = new LogBuilder();
    const [one, child] = [runId(1), runId(2)];
    simpleRun(b, one, 0x100);
    simpleRun(b, child, 0x200, { parent: one });
    const { dir } = harnessWith({ log: b.text() });
    const summary = foldSummary(
      loaded(loadRun({ harnessDir: dir, ref: SESSION, envVars: {}, now: NOW })),
    );
    expect(summary.subject).toEqual({ kind: "run", run: one, session: SESSION });
    expect(summary.runs).toEqual([
      { run: one, trigger: "cli", chosen: true },
      { run: child, trigger: "cli", parent: one, chosen: false },
    ]);
    expect(summary.children).toEqual([{ run: child, session: SESSION, via: "stamp" }]);
    const picked = loaded(
      loadRun({ harnessDir: dir, ref: SESSION, run: child, envVars: {}, now: NOW }),
    );
    expect(picked.run).toBe(child);
    const missing = loadRun({
      harnessDir: dir,
      ref: SESSION,
      run: runId(9),
      envVars: {},
      now: NOW,
    });
    expect(missing).toMatchObject({ ok: false, code: "not_found" });
  });

  test("a ref that is neither a run nor a session is refused as invalid", () => {
    const { dir } = harnessWith({});
    for (const ref of ["run_123", "sess_XYZ", "../etc/passwd", ""]) {
      expect(loadRun({ harnessDir: dir, ref, envVars: {}, now: NOW })).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
  });

  test("an unknown run is not found, and the refusal names the verb that helps", () => {
    const { dir } = harnessWith({});
    const answer = loadRun({ harnessDir: dir, ref: runId(7), envVars: {}, now: NOW });
    expect(answer).toMatchObject({ ok: false, code: "not_found" });
    expect(!answer.ok && answer.verb).toContain("crewhaus runs inspect");
  });
});

describe("reading starts at the run's first byte", () => {
  test("a run read by its id reads nothing below its sessionAt: a torn or foreign line there is never seen", () => {
    const b = new LogBuilder();
    b.raw("{ torn before the run\n");
    b.add("user_message", { content: "an earlier run's ask" }, { run: runId(1) });
    const sessionAt = b.size;
    const run = runId(2);
    simpleRun(b, run, 0x200);
    const { dir } = harnessWith({
      log: b.text(),
      rows: [{ id: run, state: "running", trigger: { kind: "cli" }, session: SESSION, sessionAt }],
    });
    const reads: Array<[number, number]> = [];
    const got = loaded(
      loadRun({
        harnessDir: dir,
        ref: run,
        envVars: {},
        now: NOW,
        onRead: (position, length) => reads.push([position, length]),
      }),
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.min(...reads.map(([position]) => position))).toBe(sessionAt);
    expect(got.gaps.filter((gap) => gap.reason === "torn")).toEqual([]);
    expect(got.lines.every((line) => line.off >= sessionAt)).toBe(true);
    expect(JSON.stringify(page(foldTimeline(got, { view: "full" })))).not.toContain(
      "an earlier run",
    );
  });
});

describe("only the session root's own files are read", () => {
  test("a session log that is a link out of the sessions folder is refused as a link, saying why", () => {
    const b = new LogBuilder();
    simpleRun(b, runId(1), 0x100);
    const outside = harnessWith({ log: b.text() });
    const { dir, sessions } = harnessWith({});
    symlinkSync(join(outside.sessions, `${SESSION}.jsonl`), join(sessions, `${SESSION}.jsonl`));
    const answer = loadRun({ harnessDir: dir, ref: SESSION, envVars: {}, now: NOW });
    expect(answer).toMatchObject({
      ok: false,
      code: "unsupported",
      message: "the session log is a link, which is not read",
    });
  });

  test("a session log that is a link inside the folder is refused as a link", () => {
    const b = new LogBuilder();
    simpleRun(b, runId(1), 0x100);
    const { dir, sessions } = harnessWith({});
    writeFileSync(join(sessions, "elsewhere.jsonl"), b.text());
    symlinkSync(join(sessions, "elsewhere.jsonl"), join(sessions, `${SESSION}.jsonl`));
    const answer = loadRun({ harnessDir: dir, ref: SESSION, envVars: {}, now: NOW });
    expect(answer).toMatchObject({
      ok: false,
      code: "unsupported",
      message: "the session log is a link, which is not read",
    });
  });

  test("a sessions folder the harness's env moves outside the harness is refused, naming the setting", () => {
    const { dir } = harnessWith({});
    const elsewhere = harnessWith({}).dir;
    // An override that escapes is ignored, and the default stays; a default that is a
    // link out of the harness is what leaves no contained root at all.
    rmSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
    mkdirSync(join(elsewhere, "moved"), { recursive: true });
    symlinkSync(join(elsewhere, "moved"), join(dir, ".crewhaus", "sessions"));
    const answer = loadRun({
      harnessDir: dir,
      ref: SESSION,
      envVars: { CREWHAUS_SESSION_DIR: join(elsewhere, "moved") },
      now: NOW,
    });
    expect(answer).toMatchObject({
      ok: false,
      code: "unsupported",
      message:
        "this harness's sessions folder lies outside the harness directory, so its records are not read",
      verb: "CREWHAUS_SESSION_DIR",
    });
  });
});

describe("a transcript outside a harness", () => {
  test("an eval sample's transcript folds like a session log", () => {
    const b = new LogBuilder();
    const run = runId(4);
    simpleRun(b, run, 0x400, {
      trigger: { kind: "eval" },
      ask: "sample input",
      answer: "sample output",
    });
    const got = loadedRunFromText(b.text(), { now: NOW });
    if (!got.ok) throw new Error(got.message);
    const summary = foldSummary(got);
    expect(summary.subject).toMatchObject({ kind: "run", run });
    expect(summary.trigger.value?.words).toBe("An eval sample");
    expect(summary.asked).toMatchObject({ state: "recorded", value: "sample input" });
    expect(summary.outcome.value).toBe("sample output");
    expect(summary.status.value?.word).toBe("Finished");
  });
});
