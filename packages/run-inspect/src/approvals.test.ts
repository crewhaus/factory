/**
 * An approval's later outcome comes from the session root's decision log, joined by the
 * approval id the verdict names, in the inspected session, and by run when the line
 * names one. Never by the action digest: a moved call's superseded approval and its
 * replacement share one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  LogBuilder,
  NOW,
  SESSION,
  apprId,
  decisionLine,
  harnessWith,
  removeFixtures,
  runId,
  spanId,
} from "./__fixtures__/build";
import {
  type CheckView,
  type LoadedRun,
  type TimelinePage,
  foldSummary,
  foldTimeline,
  foldWhy,
  loadRun,
} from "./index";

afterAll(removeFixtures);

const DIGEST = "c".repeat(64);

/** A run that calls Write once, and the checks that call met. */
function runWithCall(
  b: LogBuilder,
  run: string,
  base: number,
  verdicts: ReadonlyArray<{ outcome: string; approval?: string }>,
): string {
  const root = spanId(base + 1);
  const tool = spanId(base + 2);
  b.stamp(run, root);
  b.add("user_message", { content: "write the file" }, { run, span: root });
  b.add("tool_use", { id: "tu_1", name: "Write", input: { path: "out.md" } }, { run, span: tool });
  for (const verdict of verdicts) {
    b.add(
      "verdict",
      {
        v: 1,
        run,
        span: tool,
        on: { kind: "tool", toolUseId: "tu_1", call: 1, actionDigest: DIGEST },
        gate: "approval",
        outcome: verdict.outcome,
        ...(verdict.approval !== undefined ? { refs: { approval: verdict.approval } } : {}),
      },
      { run, span: tool },
    );
  }
  b.close(run, tool, "tool", { parent: root, toolUseId: "tu_1", call: 1, status: "parked" });
  b.close(run, root, "run", { status: "parked" });
  return tool;
}

function load(dir: string, ref: string): LoadedRun {
  const got = loadRun({ harnessDir: dir, ref, envVars: {}, now: NOW });
  if (!got.ok) throw new Error(got.message);
  return got;
}

function checksOf(run: LoadedRun, tool: string): readonly CheckView[] {
  const got = foldWhy(run, `tool:${tool}`);
  if ("ok" in got) throw new Error(got.message);
  return got.checks.value ?? [];
}

function timeline(run: LoadedRun): TimelinePage {
  const got = foldTimeline(run, { view: "full" });
  if ("ok" in got) throw new Error(got.message);
  return got;
}

describe("an approval's later outcome", () => {
  test("a parked verdict and an expire line for the same approval read 'parked, then expired'", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const tool = runWithCall(b, run, 0x100, [{ outcome: "parked", approval: apprId(1) }]);
    const { dir } = harnessWith({
      log: b.text(),
      decisions: [
        decisionLine("park", apprId(1), { runId: run }),
        decisionLine("expire", apprId(1), { runId: run, reason: "ttl" }),
      ],
    });
    const loaded = load(dir, SESSION);
    const [check] = checksOf(loaded, tool);
    expect(check).toMatchObject({ gate: "approval", outcome: "parked", approval: apprId(1) });
    const parkLine = `${JSON.stringify(decisionLine("park", apprId(1), { runId: run }))}\n`;
    // The id is the decision-log line's segment and byte offset.
    expect(check?.later.map((l) => [l.outcome, l.id])).toEqual([
      ["expired", `d:1:${Buffer.byteLength(parkLine)}`],
    ]);
    const entries = timeline(loaded).entries;
    expect(entries.map((e) => e.title)).toContain("Approval expired");
    expect(foldSummary(loaded).happened.value).toContain(
      "Asked for approval once; it expired later.",
    );
  });

  test("a moved call: approval A superseded, its replacement B with the same digest consumed, never B superseded", () => {
    const b = new LogBuilder();
    const parking = runId(1);
    const resuming = runId(2);
    const parkTool = runWithCall(b, parking, 0x100, [{ outcome: "parked", approval: apprId(0xa) }]);
    const resumeTool = runWithCall(b, resuming, 0x200, [
      { outcome: "consumed", approval: apprId(0xb) },
    ]);
    const { dir } = harnessWith({
      log: b.text(),
      decisions: [
        decisionLine("park", apprId(0xa), { runId: parking, inputDigest: DIGEST }),
        decisionLine("supersede", apprId(0xa), {
          runId: parking,
          inputDigest: DIGEST,
          reason: "moved",
        }),
        decisionLine("park", apprId(0xb), { runId: parking, inputDigest: DIGEST }),
        decisionLine("decide", apprId(0xb), {
          runId: parking,
          inputDigest: DIGEST,
          choice: "grant",
          by: "prn_00000000000000000000000001",
        }),
        decisionLine("consume", apprId(0xb), { runId: parking, inputDigest: DIGEST }),
      ],
    });
    const first = loadRun({ harnessDir: dir, ref: SESSION, run: parking, envVars: {}, now: NOW });
    const second = loadRun({ harnessDir: dir, ref: SESSION, run: resuming, envVars: {}, now: NOW });
    if (!first.ok || !second.ok) throw new Error("refused");
    const a = checksOf(first, parkTool)[0];
    const bCheck = checksOf(second, resumeTool)[0];
    expect(a?.outcome).toBe("parked");
    expect(a?.later.map((l) => l.outcome)).toEqual(["superseded"]);
    expect(bCheck?.outcome).toBe("consumed");
    expect(bCheck?.later.map((l) => l.outcome)).toEqual([]);
    expect(JSON.stringify(timeline(second))).not.toContain("superseded");
  });

  test("a parked verdict with no decision-log line reads 'parked' and nothing later", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const tool = runWithCall(b, run, 0x100, [{ outcome: "parked", approval: apprId(1) }]);
    const { dir } = harnessWith({ log: b.text() });
    const loaded = load(dir, SESSION);
    const [check] = checksOf(loaded, tool);
    expect(check).toMatchObject({ outcome: "parked", later: [] });
    expect(timeline(loaded).entries.some((e) => e.kind === "approval-outcome")).toBe(false);
    // A verdict with no approval id gets no later outcome either.
    const c = new LogBuilder();
    const bare = runWithCall(c, run, 0x100, [{ outcome: "parked" }]);
    const other = harnessWith({
      log: c.text(),
      decisions: [decisionLine("expire", apprId(1), { runId: run })],
    });
    expect(checksOf(load(other.dir, SESSION), bare)[0]?.later).toEqual([]);
  });

  test("a line for another run's approval is not attributed, whether it shares the digest or the id", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const tool = runWithCall(b, run, 0x100, [{ outcome: "parked", approval: apprId(1) }]);
    const { dir } = harnessWith({
      log: b.text(),
      decisions: [
        // Same digest, another approval.
        decisionLine("expire", apprId(2), { runId: run, inputDigest: DIGEST }),
        // Same approval id, another run.
        decisionLine("expire", apprId(1), { runId: runId(9) }),
        // Same approval id, another session.
        decisionLine("supersede", apprId(1), { runId: run, sessionId: "sess_00000000000000ff" }),
      ],
    });
    const [check] = checksOf(load(dir, SESSION), tool);
    expect(check?.later).toEqual([]);
  });

  test("a grant on a parked verdict of the same run shows who granted it and where", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const tool = runWithCall(b, run, 0x100, [{ outcome: "parked", approval: apprId(1) }]);
    const { dir } = harnessWith({
      log: b.text(),
      decisions: [
        decisionLine("decide", apprId(1), {
          runId: run,
          choice: "grant",
          by: "local:#0123abcd",
          surface: "home",
        }),
      ],
    });
    const loaded = load(dir, SESSION);
    const [check] = checksOf(loaded, tool);
    expect(check?.later).toMatchObject([
      { outcome: "granted", by: "local:#0123abcd", surface: "home" },
    ]);
    expect(timeline(loaded).entries.find((e) => e.kind === "approval-outcome")).toMatchObject({
      title: "Approval granted",
      detail: "by local:#0123abcd in home",
      importance: "key",
    });
  });
});
