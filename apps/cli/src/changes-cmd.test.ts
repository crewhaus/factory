/**
 * `crewhaus changes`, the quality receipts and the CLI's change producers, against a
 * throwaway harness: every writing verb runs under its `quality.changes.*` receipt in
 * the harness's own ledger; a re-anchor's receipt is named by the pin it made; a loop
 * that proposes never writes the spec; a write-back records the change it made.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import { foldStates } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { readChanges } from "@crewhaus/quality-service";
import { producedLines, proposeChange, recordWriteBack } from "./change-producers";
import { runChangesCommand } from "./changes-cmd";
import { runFlywheelLoop } from "./flywheel";
import { reanchorUnderReceipt } from "./quality-receipts";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const SPEC = `name: shop
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: Help the customer.
`;
const PROPOSED = SPEC.replace("Help the customer.", "Help the customer, briefly.");

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function harness(): { dir: string; env: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "changes-cmd-")));
  roots.push(root);
  const dir = join(root, "harness");
  put(dir, "crewhaus.yaml", SPEC);
  put(dir, "eval/graders.yaml", "graders:\n  - name: exact\n    type: exact_match\n");
  put(dir, "proposed.yaml", PROPOSED);
  return {
    dir,
    env: {
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
      CREWHAUS_HANGAR_ROOT: join(root, "hangar"),
      CREWHAUS_NO_REGISTRY: "1",
    },
  };
}

function receipts(dir: string): Record<string, unknown>[] {
  const fold = foldStates(commandsLedgerOf(dir));
  return fold.ok ? [...fold.objects.values()].map((o) => o.record as Record<string, unknown>) : [];
}

describe("crewhaus changes", () => {
  test("propose files a change under one receipt and writes nothing to the spec", async () => {
    const { dir, env } = harness();
    const out = await runChangesCommand(["propose", "--from", "proposed.yaml"], { cwd: dir, env });
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toMatch(/^proposed chg_/);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows).toHaveLength(1);
    const row = read.rows[0];
    expect(row?.state).toBe("proposed");
    const [receipt] = receipts(dir);
    expect(receipt?.["kind"]).toBe("quality.changes.create");
    expect(receipt?.["state"]).toBe("succeeded");
    expect(row?.cmd).toBe(receipt?.["id"] as string);
    expect(String(receipt?.["target"])).toEndWith(`/change/${row?.id}`);
  });

  test("propose --dry-run names the id it would file and writes nothing", async () => {
    const { dir, env } = harness();
    const out = await runChangesCommand(["propose", "--from", "proposed.yaml", "--dry-run"], {
      cwd: dir,
      env,
    });
    expect(out.lines[0]).toMatch(/^would file chg_/);
    expect(readChanges(dir).state).toBe("absent");
    expect(receipts(dir)).toEqual([]);
  });

  test("list and show read; withdraw runs under its receipt", async () => {
    const { dir, env } = harness();
    await runChangesCommand(["propose", "--from", "proposed.yaml"], { cwd: dir, env });
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    const chg = read.rows[0]?.id as string;
    const listed = await runChangesCommand(["list"], { cwd: dir, env });
    expect(listed.lines.join("\n")).toContain(chg);
    const shown = await runChangesCommand(["show", chg], { cwd: dir, env });
    expect(shown.lines.join("\n")).toContain(`crewhaus changes check ${chg}`);
    expect(receipts(dir)).toHaveLength(1);
    const withdrawn = await runChangesCommand(["withdraw", chg], { cwd: dir, env });
    expect(withdrawn.exitCode).toBe(0);
    const after = readChanges(dir);
    expect(after.state === "present" && after.rows[0]?.state).toBe("withdrawn");
    expect(receipts(dir).map((r) => r["kind"])).toContain("quality.changes.withdraw");
  });

  test("decline needs a reason a person may give", async () => {
    const { dir, env } = harness();
    await expect(
      runChangesCommand(["decline", "chg_01m76e6f05hp514w9j4v3qymka", "--reason", "regressed"], {
        cwd: dir,
        env,
      }),
    ).rejects.toThrow(/--reason is one of/);
  });

  test("adopt of a change with no granted decision is refused under a rejected receipt", async () => {
    const { dir, env } = harness();
    await runChangesCommand(["propose", "--from", "proposed.yaml"], { cwd: dir, env });
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    const row = read.rows[0];
    const out = await runChangesCommand(
      ["adopt", row?.id as string, "--expect", row?.base.revision as string],
      { cwd: dir, env },
    );
    expect(out.exitCode).not.toBe(0);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(SPEC);
    const adopt = receipts(dir).find((r) => r["kind"] === "quality.changes.adopt");
    expect(adopt?.["state"]).toBe("rejected");
  });
});

describe("a re-anchor's receipt", () => {
  test("is written before the pin, and the pin is handed its id", async () => {
    const { dir, env } = harness();
    let seen: string | undefined;
    const outcome = await reanchorUnderReceipt({
      harnessDir: dir,
      runId: "run_0123456789abcdef",
      reason: "instrument-changed",
      env,
      pin: (receipt) => {
        seen = receipt;
        // The receipt is in the ledger before the pin runs.
        expect(receipts(dir).map((r) => r["id"])).toContain(receipt);
        return { ok: false, refusal: { code: "nothing_measured", reason: "test pin" } };
      },
    });
    expect(seen).toMatch(/^cmd_/);
    expect(outcome.ok).toBe(false);
    const [receipt] = receipts(dir);
    expect(receipt?.["kind"]).toBe("quality.baselines.rebaseline");
    expect(String(receipt?.["target"])).toEndWith("/evalrun/run_0123456789abcdef");
  });

  test("a receipt that cannot be written answers a receipt refusal and never pins", async () => {
    const { dir, env } = harness();
    // A file where the harness's control directory belongs makes the ledger unwritable.
    put(dir, ".crewhaus/run/control", "not a directory");
    let pinned = false;
    const outcome = await reanchorUnderReceipt({
      harnessDir: dir,
      runId: "run_0123456789abcdef",
      env,
      pin: () => {
        pinned = true;
        return { ok: false, refusal: { code: "nothing_measured", reason: "x" } };
      },
    });
    expect(pinned).toBe(false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.code).toBe("receipt");
  });
});

describe("the CLI's change producers", () => {
  test("a proposing loop files a proposed change and the spec is byte-identical", async () => {
    const { dir, env } = harness();
    const before = readFileSync(join(dir, "crewhaus.yaml"));
    const filed = await proposeChange({
      specPath: join(dir, "crewhaus.yaml"),
      source: "optimize",
      baseText: SPEC,
      candidateText: PROPOSED,
      dataset: join(dir, "eval/dataset.jsonl"),
      env,
    });
    expect(filed.ok).toBe(true);
    expect(readFileSync(join(dir, "crewhaus.yaml")).equals(before)).toBe(true);
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows.map((r) => [r.state, r.source])).toEqual([["proposed", "optimize"]]);
    expect(producedLines("[optimize]", filed)[0]).toContain("the spec was not written");
  });

  test("a write-back records the change it made as adopted", async () => {
    const { dir, env } = harness();
    writeFileSync(join(dir, "crewhaus.yaml"), PROPOSED);
    const recorded = await recordWriteBack({
      specPath: join(dir, "crewhaus.yaml"),
      source: "flywheel",
      baseText: SPEC,
      candidateText: PROPOSED,
      env,
    });
    expect(recorded.ok).toBe(true);
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows.map((r) => [r.state, r.source, r.via])).toEqual([
      ["adopted", "flywheel", "cli"],
    ]);
  });
});

describe("flywheel run --propose", () => {
  const summary = (passRate: number, passed: boolean[]): EvalRunSummary =>
    ({
      runId: `run_${passRate}`,
      startedAt: "t",
      endedAt: "t",
      samples: passed.map((p, i) => ({
        sampleId: `s${i}`,
        sessionId: "sess",
        startedAt: "t",
        endedAt: "t",
        latencyMs: 1,
        turns: 1,
        tokens: { input: 0, output: 0 },
        model: "m",
        agentOutput: "x",
        grades: { overall: { passed: p, score: p ? 1 : 0, rationale: "" }, perGrader: [] },
      })),
      aggregates: {
        passRate,
        meanScore: passRate,
        p50Turns: 1,
        p95Turns: 1,
        p50LatencyMs: 1,
        p95LatencyMs: 1,
        totalTokens: { input: 0, output: 0 },
        errorCount: 0,
      },
      config: { specHash: "s", datasetName: "d", graderNames: [], model: "m", concurrency: 1 },
      outDir: "/x",
    }) as unknown as EvalRunSummary;

  test("an accepted candidate is one proposed change, its evidence the gate's, and the spec is untouched", async () => {
    const { dir, env } = harness();
    const before = readFileSync(join(dir, "crewhaus.yaml"));
    const result = await runFlywheelLoop({
      sourceYaml: SPEC,
      dryRun: false,
      hooks: {
        compileCheck: () => undefined,
        evalRun: async (label) =>
          label === "before" ? summary(0.5, [true, false]) : summary(1, [true, true]),
        optimize: async () => ({
          applied: true,
          patchedYaml: PROPOSED,
          runId: "opt_1",
          outDir: "/x",
          scoreBefore: 0.5,
          scoreAfter: 1,
          mutatorName: "rule-based",
          iterations: 1,
          spendUsd: "$0",
        }),
        applyAccepted: async (outcome, measured) => {
          const filed = await proposeChange({
            specPath: join(dir, "crewhaus.yaml"),
            source: "flywheel",
            baseText: SPEC,
            candidateText: outcome.patchedYaml,
            evidence: {
              passRateBefore: measured?.before.aggregates.passRate,
              passRateAfter: measured?.after.aggregates.passRate,
            },
            env,
          });
          if (!filed.ok) throw new Error(filed.reason);
        },
      },
    });
    expect(result.outcome).toBe("accepted");
    expect(readFileSync(join(dir, "crewhaus.yaml")).equals(before)).toBe(true);
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows.map((r) => [r.state, r.source])).toEqual([["proposed", "flywheel"]]);
    const evidence = JSON.parse(
      readFileSync(join(dir, read.rows[0]?.contentRef as string, "evidence.json"), "utf8"),
    );
    expect(evidence).toEqual({ passRateBefore: 0.5, passRateAfter: 1 });
  });
});

describe("what a changes writer records on its way past", () => {
  /** A spec change on the lifecycle, moved legally up to `to`. */
  async function changeIn(dir: string, to: "checking" | "monitoring"): Promise<string> {
    const { createChange, moveChange, readChange } = await import("@crewhaus/quality-service");
    const at = Date.now() - 60_000;
    const created = await createChange({
      harnessDir: dir,
      kind: "spec",
      source: "manual",
      spec: "crewhaus.yaml",
      graders: "eval/graders.yaml",
      dataset: "eval/dataset.jsonl",
      baseText: SPEC,
      candidateText: PROPOSED,
      actor: "sys:reconcile",
      now: () => at,
      ...(to === "monitoring" ? { adopted: {} } : {}),
    });
    if (!created.ok) throw new Error(created.reason);
    const id = created.row.id;
    const path =
      to === "checking" ? (["checking"] as const) : (["activated", "monitoring"] as const);
    let from = created.row.state;
    for (const state of path) {
      const row = readChange(dir, id);
      if (row === undefined) throw new Error("no row");
      const moved = await moveChange(dir, from, {
        ...row,
        state,
        at: new Date(at).toISOString(),
        ...(state === "monitoring" ? { until: new Date(at + 3_600_000).toISOString() } : {}),
      });
      if (!moved.ok) throw new Error(moved.reason);
      from = state;
    }
    return id;
  }

  test("an SLO rollback the run path recorded is written as rolled back by sys:slo", async () => {
    const { dir, env } = harness();
    const chg = await changeIn(dir, "monitoring");
    const { openAuditLog } = await import("@crewhaus/audit-log");
    const log = await openAuditLog({ rootDir: join(dir, ".crewhaus", "audit") });
    await log.append({ kind: "slo_mitigation", payload: { rung: "rollback" } });
    const out = await runChangesCommand(["propose", "--from", "proposed.yaml"], { cwd: dir, env });
    expect(out.exitCode).toBe(0);
    const read = readChanges(dir);
    if (read.state !== "present") throw new Error(read.state);
    const row = read.rows.find((r) => r.id === chg);
    expect(row?.state).toBe("rolled-back");
    expect(row?.actor).toBe("sys:slo");
  });

  test("a watched change with no SLO rollback is left watching before its end", async () => {
    const { dir, env } = harness();
    const chg = await changeIn(dir, "monitoring");
    await runChangesCommand(["propose", "--from", "proposed.yaml"], { cwd: dir, env });
    const read = readChanges(dir);
    expect(read.state === "present" && read.rows.find((r) => r.id === chg)?.state).toBe(
      "monitoring",
    );
  });

  test("a check that was interrupted is failed by the next writer, and can be checked again", async () => {
    const { dir, env } = harness();
    const chg = await changeIn(dir, "checking");
    const out = await runChangesCommand(["withdraw", chg], { cwd: dir, env });
    expect(out.exitCode).toBe(0);
    const read = readChanges(dir);
    // failed, then withdrawn by the verb the person asked for.
    expect(read.state === "present" && read.rows.find((r) => r.id === chg)?.state).toBe(
      "withdrawn",
    );
  });
});

describe("what a person decides is refused under an agent's tool", () => {
  const AGENT = { CREWHAUS_AGENT_TOOL: "Bash" };
  const CHG = "chg_01m76e6f05hp514w9j4v3qymka";
  for (const argv of [
    ["check", CHG, "--live"],
    ["check", CHG, "--live", "--yes"],
    ["adopt", CHG, "--expect", `sha256:${"a".repeat(64)}`],
    ["rollback", CHG, "--expect", `sha256:${"a".repeat(64)}`],
  ]) {
    test(`changes ${argv.join(" ")}`, async () => {
      const { dir, env } = harness();
      const out = await runChangesCommand(argv, { cwd: dir, env: { ...env, ...AGENT } });
      expect(out.exitCode).toBe(EXIT_FOR_ERROR.forbidden);
      expect(out.lines.join("\n")).toContain("started by an agent's tool");
      expect(receipts(dir)).toEqual([]);
    });
  }
});
