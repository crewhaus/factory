/**
 * Two quality journeys, through the code the CLI runs:
 *
 * - Relax a check: the next `eval --gate` reads not comparable, and
 *   `--regrade-baseline` compares this run with the baseline's own answers
 *   graded the new way; over a protected criterion that needs the owner.
 * - A new criterion observes first: `criteria show` says what it would have
 *   failed, `criteria apply` turns it to enforcing, and the next run enforces.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { gradersConfigHash, parseGradersConfig, runCriteriaRecord } from "@crewhaus/eval-grader";
import { finishEvalRun } from "@crewhaus/eval-ops";
import { getBaseline, loadRun, recordEvalRun } from "@crewhaus/eval-report";
import { type EvalRunSummary, runEval } from "@crewhaus/eval-runner";
import { parseSpec } from "@crewhaus/spec";
import { gradersRevision, runCriteriaCommand } from "./criteria-cmd";
import { regradeRecordedRun } from "./eval-regrade";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-criteria-journey-"));
  TMP.push(dir);
  return dir;
};

const SPEC = "name: shop\ntarget: cli\nagent:\n  model: m\n  instructions: Answer.\n";
const ir = () => {
  const lowered = lower(parseSpec(SPEC));
  if (lowered.target !== "cli") throw new Error("cli");
  return lowered;
};
const SAMPLES: Sample[] = [
  { id: "a", input: "q", expected_output: "Paris" },
  { id: "b", input: "q", expected_output: "Rome" },
];
/** The agent's answers: right in substance, not always in form. */
const answer = async ({ sample }: { sample: Sample }) => ({
  agentOutput: sample.id === "b" ? "rome" : (sample.expected_output ?? ""),
});

async function liveRun(graders: string, outDir: string, invoker = answer): Promise<EvalRunSummary> {
  const { compiled, config } = parseGradersConfig(graders);
  const criteria = runCriteriaRecord(config);
  async function* stream(): AsyncIterable<Sample> {
    for (const s of SAMPLES) yield s;
  }
  return runEval({
    ir: ir(),
    dataset: { name: "capitals", samples: stream() },
    compiledGraders: compiled,
    opts: {
      invoker,
      outDir,
      datasetHash: "d".repeat(64),
      gradersHash: gradersConfigHash(config),
      ...(criteria !== undefined ? { criteria } : {}),
      readCalibrationFile: () => undefined,
    },
  });
}

describe("journey: relax a check, then compare on the same answers", () => {
  const STRICT = (protectedLine: string) => `graders:
  - name: match
    type: exact_match
criteria:
  - id: capital-named
${protectedLine}    measured_by: [match]
`;
  const RELAXED = (protectedLine: string) =>
    STRICT(protectedLine).replace(
      "    type: exact_match\n",
      "    type: exact_match\n    case_insensitive: true\n",
    );

  async function journey(
    protectedLine: string,
    owner: ReturnType<NonNullable<Parameters<typeof finishEvalRun>[0]["ownerCheck"]>>,
  ) {
    const dir = newDir();
    const evalsDir = join(dir, "evals");
    const lines: string[] = [];
    const finish = (
      summary: EvalRunSummary,
      extra: Partial<Parameters<typeof finishEvalRun>[0]> = {},
    ) =>
      finishEvalRun({
        summary,
        specName: "shop",
        datasetHash: "d".repeat(64),
        outDir: summary.outDir,
        gateRequested: true,
        promote: true,
        evalsDir,
        write: (l) => lines.push(l),
        warn: () => {},
        ownerCheck: () => owner,
        ...extra,
      });
    const baseline = await liveRun(STRICT(protectedLine), join(evalsDir, "run_base0001"));
    await finish(baseline);
    // The relaxed check measures differently: not comparable under --gate.
    const relaxed = await liveRun(RELAXED(protectedLine), join(evalsDir, "run_next0001"));
    const plain = await finish(relaxed);
    expect(plain.gateFailed).toBe(true);
    expect(plain.notComparable).toBe("instrument");
    // --regrade-baseline grades the baseline's answers with the relaxed check.
    const { compiled, config } = parseGradersConfig(RELAXED(protectedLine));
    let regrades = 0;
    const result = await finish(relaxed, {
      regradeBaseline: async (pin) => {
        regrades += 1;
        const regraded = await regradeRecordedRun({
          ir: ir(),
          sourceDir: pin.outDir,
          purpose: "regrade",
          datasetName: "capitals",
          samples: SAMPLES,
          datasetHash: "d".repeat(64),
          compiled,
          gradersConfig: config,
          gradersHash: gradersConfigHash(config),
          outDir: join(evalsDir, "run_regraded01"),
          record: { specName: "shop", evalsDir },
        });
        return loadRun(resolve(regraded.outDir));
      },
    });
    return { result, regrades, evalsDir, lines };
  }

  test("an unprotected check: the gate compares on the same answers and re-anchors, marked", async () => {
    const { result, regrades, evalsDir } = await journey("", { ok: true });
    expect(regrades).toBe(1);
    expect(result.gateFailed).toBe(false);
    expect(result.rebaselined).toBe(true);
    const pin = getBaseline("shop", "capitals", evalsDir);
    expect(pin?.runId).not.toBe("run_base0001");
    expect(pin?.rebaselined).toEqual({
      from: expect.any(String),
      reason: "instrument-changed",
      cmd: "crewhaus eval --regrade-baseline",
    });
  });

  test("a protected check needs the owner: refused and nothing pinned without, marked with", async () => {
    const refused = await journey("    protected: true\n", {
      ok: false,
      reason: "the list of who may approve cannot be read",
    });
    expect(refused.regrades).toBe(0);
    expect(refused.result.refused).toContain("protected criterion capital-named changed");
    const before = getBaseline("shop", "capitals", refused.evalsDir);
    expect(before?.rebaselined).toBeUndefined();

    const allowed = await journey("    protected: true\n", { ok: true, principal: "prn_owner" });
    expect(allowed.result.rebaselined).toBe(true);
    expect(getBaseline("shop", "capitals", allowed.evalsDir)?.rebaselined?.protectedChange).toBe(
      true,
    );
  });
});

describe("journey: a new criterion observes, then enforces", () => {
  test("show reports what it would fail, apply turns it on, and the next run enforces", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "crewhaus.yaml"), SPEC);
    mkdirSync(join(dir, "eval"));
    const graders = `graders:
  - name: match
    type: exact_match
criteria:
  - id: capital-named
    description: The answer names the capital exactly.
    mode: observe
    measured_by: [match]
`;
    const gradersPath = join(dir, "eval", "graders.yaml");
    writeFileSync(gradersPath, graders);
    const evalsDir = join(dir, ".crewhaus", "evals");
    const first = await liveRun(graders, join(evalsDir, "run_obs00001"));
    recordEvalRun(first, {
      specName: "shop",
      datasetHash: "d".repeat(64),
      outDir: resolve(first.outDir),
      evalsDir,
    });
    // Observing: no verdict about the spec, but what it would have failed.
    expect(first.samples.every((s) => s.grades.overall.status === "observing")).toBe(true);
    const shown = await runCriteriaCommand(["show", "capital-named"], { cwd: dir });
    expect(shown.lines.join("\n")).toContain("observing 2 (would fail 1 of 2)");

    const edits = join(dir, "enforce.json");
    writeFileSync(
      edits,
      JSON.stringify([{ op: "setMode", id: "capital-named", value: "enforce" }]),
    );
    const applied = await runCriteriaCommand(
      ["apply", edits, "--expect", gradersRevision(graders)],
      { cwd: dir, ownerCheck: () => ({ ok: true }) },
    );
    expect(applied.exitCode).toBe(0);

    const next = await liveRun(readFileSync(gradersPath, "utf8"), join(evalsDir, "run_enf00001"));
    const b = next.samples.find((s) => s.sampleId === "b");
    expect(b?.grades.perGrader[0]?.status).toBeUndefined();
    expect(b?.grades.overall.status).toBeUndefined();
    expect(b?.grades.overall.passed).toBe(false);
    expect(next.aggregates.passRate).toBe(0.5);
  });
});
