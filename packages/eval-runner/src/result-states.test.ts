/**
 * Result states in the run's figures: a sample that was not measured, skipped
 * or only observed has no verdict about the spec, so every denominator that
 * leaves out an abstained sample leaves it out too, and the aggregates list it.
 * Also what the run directory records: each case's digest (`cases.json`) and
 * the digest of the plugin graders the run resolved.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { type GradeResult, parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { aggregate } from "./aggregate";
import { CASES_FILENAME, caseDigestOf } from "./cases";
import { defaultGraderRegistry } from "./default-registry";
import { runEval } from "./index";
import { computeSlices, gradeStatusOf, sampleWithoutVerdict } from "./slices";
import type { SampleResult } from "./types";

const TMP: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-result-states-"));
  TMP.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

function sample(
  id: string,
  overall: Partial<GradeResult> & { passed: boolean },
  extra: Partial<SampleResult> = {},
  perGrader: Array<{ name: string } & GradeResult> = [],
): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-11-01T00:00:00Z",
    endedAt: "2026-11-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 1, output: 1 },
    model: "m",
    agentOutput: "x",
    grades: {
      overall: { score: overall.passed ? 1 : 0, rationale: "", ...overall },
      perGrader,
    },
    ...extra,
  };
}

const pass = (id: string, extra: Partial<SampleResult> = {}) => sample(id, { passed: true }, extra);
const notMeasured = (id: string, extra: Partial<SampleResult> = {}) =>
  sample(id, { passed: false, status: "not_measured", statusReason: "no_proof_bundle" }, extra);

describe("aggregate — samples without a verdict", () => {
  test("a not-measured sample leaves the denominator and is listed", () => {
    const agg = aggregate([pass("a"), notMeasured("b")]);
    expect(agg.passRate).toBe(1);
    expect(agg.notMeasured).toBe(1);
    expect(agg.notMeasuredSampleIds).toEqual(["b"]);
    expect(agg.measured).toBe(1);
    expect(agg.meanScore).toBe(1);
  });

  test("a run of nothing but a not-measured sample measured nothing and has no pass-rate interval", () => {
    const agg = aggregate([notMeasured("b")]);
    expect(agg.measured).toBe(0);
    expect(agg.passRateCI95).toBeUndefined();
    expect(typeof agg.passRate).toBe("number");
  });

  test("skipped and observing samples leave the denominator; observing graders say what they would have failed", () => {
    const observed = (id: string, wouldPass: boolean) =>
      sample(id, { passed: false, status: "observing" }, {}, [
        {
          name: "watch",
          passed: wouldPass,
          score: wouldPass ? 1 : 0,
          rationale: "",
          status: "observing",
        },
      ]);
    const agg = aggregate([
      pass("a"),
      sample("b", { passed: false }),
      sample("s", { passed: false, status: "skipped", statusReason: "out_of_scope" }),
      observed("o1", true),
      observed("o2", false),
      // An observing entry beside an enforced one: counted, the sample keeps its verdict.
      sample("m", { passed: true }, {}, [
        { name: "own", passed: true, score: 1, rationale: "" },
        { name: "watch", passed: false, score: 0, rationale: "", status: "observing" },
      ]),
    ]);
    expect(agg.passRate).toBeCloseTo(2 / 3);
    expect(agg.skipped).toBe(1);
    expect(agg.skippedSampleIds).toEqual(["s"]);
    expect(agg.observing).toEqual({
      watch: { graded: 3, wouldFail: 2, wouldFailSampleIds: ["o2", "m"] },
    });
    expect(agg.measured).toBe(3);
  });

  test("a canary wins over every state", () => {
    const agg = aggregate([pass("a"), notMeasured("c", { metadata: { source: "canary" } })]);
    expect(agg.canary).toBe(1);
    expect(agg.notMeasured).toBeUndefined();
    expect(agg.passRate).toBe(1);
  });

  test("a state-free run with an errored or abstained sample carries no measured key", () => {
    const agg = aggregate([
      pass("a"),
      sample("e", { passed: false }, { error: "provider down" }),
      sample("j", { passed: false, abstained: true }),
    ]);
    expect("measured" in agg).toBe(false);
    expect("notMeasured" in agg).toBe(false);
    expect("observing" in agg).toBe(false);
  });

  test("the per-slice pass rate leaves the same samples out", () => {
    const slices = computeSlices(
      [
        pass("a", { metadata: { difficulty: "hard" } }),
        notMeasured("b", { metadata: { difficulty: "hard" } }),
      ],
      ["difficulty"],
    );
    expect(slices?.["difficulty"]?.["hard"]).toEqual({ sampleCount: 2, passRate: 1, meanScore: 1 });
  });

  test("an errored sample is never without a verdict: the crash wins", () => {
    expect(sampleWithoutVerdict(notMeasured("b", { error: "boom" }))).toBe(false);
    expect(sampleWithoutVerdict(notMeasured("b"))).toBe(true);
  });
});

describe("gradeStatusOf", () => {
  const legacy = { legacyProvability: true } as const;
  test("reads `status`, and a provability rationale prefix on a provability record without one", () => {
    expect(gradeStatusOf({ status: "skipped", rationale: "x" })).toBe("skipped");
    expect(gradeStatusOf({ status: "skipped", rationale: "x" }, legacy)).toBe("skipped");
    expect(
      gradeStatusOf(
        { rationale: "no proof bundle (is provability: declared?) — nothing graded" },
        legacy,
      ),
    ).toBe("not_measured");
    expect(gradeStatusOf({ rationale: "the gate could not verify this answer (x)" }, legacy)).toBe(
      "not_measured",
    );
    expect(gradeStatusOf({ rationale: "output matched" }, legacy)).toBeUndefined();
  });

  test("any other grade is read by its status alone, whatever its rationale says", () => {
    expect(
      gradeStatusOf({ rationale: "no proof bundle (is provability: declared?) — nothing graded" }),
    ).toBeUndefined();
    expect(
      gradeStatusOf({ rationale: "the gate could not verify this answer (x)" }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The run directory: cases.json and the plugin digest
// ---------------------------------------------------------------------------

const SPEC = "name: states\ntarget: cli\nagent:\n  model: m\n  instructions: Answer.\n";
const ir = (): IrV0 => {
  const lowered = lower(parseSpec(SPEC));
  if (lowered.target !== "cli") throw new Error("expected cli");
  return lowered;
};
async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}
const SAMPLES: Sample[] = [
  { id: "a", input: "2+2?", expected_output: "4" },
  { id: "b", input: "3+3?", expected_output: "6", metadata: { difficulty: "hard" } },
];
const echo = async ({ sample }: { sample: Sample }) => ({
  agentOutput: sample.expected_output ?? "",
  transcript: [],
  events: [],
});

describe("runEval — what the run directory records", () => {
  test("cases.json holds each case's digest, and a changed case changes its digest", async () => {
    const outDir = tempDir();
    const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");
    await runEval({
      ir: ir(),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders: compiled,
      opts: { invoker: echo, outDir },
    });
    const cases = JSON.parse(readFileSync(join(outDir, CASES_FILENAME), "utf8"));
    expect(cases).toEqual({
      version: 1,
      digests: { a: caseDigestOf(SAMPLES[0] as Sample), b: caseDigestOf(SAMPLES[1] as Sample) },
    });
    expect(caseDigestOf({ ...(SAMPLES[0] as Sample), expected_output: "5" })).not.toBe(
      cases.digests.a,
    );
    // Key order does not move a digest.
    expect(caseDigestOf({ expected_output: "4", input: "2+2?", id: "a" })).toBe(cases.digests.a);
  });

  test("a plugin grader the run resolved is digested from its entry file; none means no digest", async () => {
    const cwd = tempDir();
    const pluginDir = join(cwd, ".crewhaus", "graders", "mine");
    mkdirSync(pluginDir, { recursive: true });
    const entry = join(pluginDir, "index.ts");
    const write = (body: string) =>
      writeFileSync(
        entry,
        `export default { name: "mine.check", grader: async () => ({ passed: true, score: 1, rationale: "${body}" }) };\n`,
      );
    const run = async (graders: string) => {
      const registry = await defaultGraderRegistry({ cwd });
      const { compiled } = parseGradersConfig(graders);
      return runEval({
        ir: ir(),
        dataset: { name: "d", samples: yieldSamples(SAMPLES) },
        compiledGraders: compiled,
        opts: { invoker: echo, outDir: tempDir(), graderRegistry: registry, cwd },
      });
    };
    const PLUGIN = "graders:\n  - name: p\n    type: registry\n    grader: mine.check\n";
    write("v1");
    const first = await run(PLUGIN);
    expect(typeof first.config.pluginsDigest).toBe("string");
    const runJson = JSON.parse(readFileSync(join(first.outDir, "run.json"), "utf8"));
    expect(runJson.pluginsDigest).toBe(first.config.pluginsDigest);
    expect((await run(PLUGIN)).config.pluginsDigest).toBe(first.config.pluginsDigest);
    // A cache-busting copy, so the edited module is loaded fresh.
    rmSync(join(cwd, ".crewhaus", "graders"), { recursive: true, force: true });
    mkdirSync(join(cwd, ".crewhaus", "graders", "mine2"), { recursive: true });
    writeFileSync(
      join(cwd, ".crewhaus", "graders", "mine2", "index.ts"),
      `export default { name: "mine.check", grader: async () => ({ passed: true, score: 1, rationale: "v2" }) };\n`,
    );
    expect((await run(PLUGIN)).config.pluginsDigest).not.toBe(first.config.pluginsDigest);
    // No grader resolves a plugin: no digest, and run.json carries none.
    const none = await run("graders:\n  - name: m\n    type: exact_match\n");
    expect(none.config.pluginsDigest).toBeUndefined();
    expect("pluginsDigest" in JSON.parse(readFileSync(join(none.outDir, "run.json"), "utf8"))).toBe(
      false,
    );
  });
});
