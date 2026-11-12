/**
 * A run with no result state writes the records it always wrote: its
 * `results.json`, its index row and its pin are byte for byte the ones a run
 * recorded before result states existed (taken as fixtures below, with the
 * fields that change from run to run — times, latencies, session ids, the
 * runtime, the output directory — blanked on both sides).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { type AgentInvoker, runEval } from "@crewhaus/eval-runner";
import { parseSpec } from "@crewhaus/spec";
import { runIndexEntryFromSummary } from "./history";
import { pinFromIndexEntry } from "./pin";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

/** The fields that differ between two runs of the same inputs. */
const VOLATILE = new Set([
  "startedAt",
  "endedAt",
  "sessionId",
  "latencyMs",
  "p50LatencyMs",
  "p95LatencyMs",
  "bunVersion",
  "platform",
  "outDir",
  "ts",
  "p50ModelCallMs",
  "p95ModelCallMs",
]);
const blank = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(blank)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, x]) => [
            k,
            VOLATILE.has(k) ? "<v>" : blank(x),
          ]),
        )
      : v;

const RESULTS_FIXTURE =
  '{"runId":"run_fixture","startedAt":"<v>","endedAt":"<v>","samples":[{"sampleId":"q1","sess' +
  'ionId":"<v>","startedAt":"<v>","endedAt":"<v>","latencyMs":"<v>","turns":0,"tokens":{"inpu' +
  't":0,"output":0},"model":"claude-opus-4-7","agentOutput":"4","grades":{"overall":{"passed"' +
  ':true,"score":1,"rationale":"[math: \u2713] output matched expected (1 chars)"},"perGrader":[{"' +
  'name":"math","passed":true,"score":1,"rationale":"output matched expected (1 chars)"}]},"m' +
  'etrics":{"interventions":0,"safetyViolations":{"permissionDenials":0,"egressBlocks":0,"jus' +
  'tificationRejections":0,"total":0},"modelCallLatenciesMs":[]}},{"sampleId":"q2","sessionId' +
  '":"<v>","startedAt":"<v>","endedAt":"<v>","latencyMs":"<v>","turns":0,"tokens":{"input":0,' +
  '"output":0},"model":"claude-opus-4-7","agentOutput":"wrong","grades":{"overall":{"passed":' +
  'false,"score":0,"rationale":"[math: \u2717] expected \\"2\\" got \\"wrong\\""},"perGrader":[{"name"' +
  ':"math","passed":false,"score":0,"rationale":"expected \\"2\\" got \\"wrong\\""}]},"metrics":{' +
  '"interventions":0,"safetyViolations":{"permissionDenials":0,"egressBlocks":0,"justificatio' +
  'nRejections":0,"total":0},"modelCallLatenciesMs":[]}},{"sampleId":"q3","sessionId":"<v>","' +
  'startedAt":"<v>","endedAt":"<v>","latencyMs":"<v>","turns":0,"tokens":{"input":0,"output":' +
  '0},"model":"claude-opus-4-7","agentOutput":"","metadata":{"difficulty":"hard"},"grades":{"' +
  'overall":{"passed":false,"score":0,"rationale":"agent invocation error: provider down"},"p' +
  'erGrader":[{"name":"math","passed":false,"score":0,"rationale":"expected \\"3\\" got \\"\\""}]' +
  '},"metrics":{"interventions":0,"safetyViolations":{"permissionDenials":0,"egressBlocks":0,' +
  '"justificationRejections":0,"total":0},"modelCallLatenciesMs":[]},"error":"provider down",' +
  '"retried":true}],"aggregates":{"passRate":0.3333333333333333,"meanScore":0.5,"p50Turns":0,' +
  '"p95Turns":0,"p50LatencyMs":"<v>","p95LatencyMs":"<v>","totalTokens":{"input":0,"output":0' +
  '},"errorCount":1,"partialScoreMean":0.3333333333333333,"interventionRate":0,"safetyViolati' +
  'ons":{"permissionDenials":0,"egressBlocks":0,"justificationRejections":0,"total":0},"p50Mo' +
  'delCallMs":"<v>","p95ModelCallMs":"<v>","passRateCI95":[0.06149194402093083,0.792340401192' +
  '1756],"meanScoreCI95":[-5.853,6.853]},"slices":{"difficulty":{"hard":{"sampleCount":1,"pas' +
  'sRate":0,"meanScore":0}}},"config":{"specHash":"4b4f91d93a898915","datasetName":"fixture3"' +
  ',"datasetHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","graders' +
  'Hash":"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg","graderNames":["m' +
  'ath"],"model":"claude-opus-4-7","concurrency":1,"cliVersion":"0.8.2","bunVersion":"<v>","p' +
  'latform":"<v>","seed":7},"outDir":"<v>"}';
const ROW_FIXTURE =
  '{"runId":"run_fixture","specName":"hello-test","specHash":"4b4f91d93a898915","datasetName"' +
  ':"fixture3","datasetHash":"ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' +
  'd","gradersHash":"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg","passR' +
  'ate":0.3333333333333333,"meanScore":0.5,"sampleCount":3,"p95LatencyMs":"<v>","retriedCount' +
  '":1,"errorCount":1,"measuredCount":2,"ts":"<v>","outDir":"<v>"}';
const PIN_FIXTURE =
  '{"specName":"hello-test","datasetName":"fixture3","runId":"run_fixture","outDir":"<v>","da' +
  'tasetHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","gradersHash' +
  '":"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg","p95LatencyMs":"<v>",' +
  '"ts":"<v>"}';

test("a run with no result state writes the results.json, index row and pin it always wrote", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "crewhaus-state-free-"));
  TMP.push(outDir);
  const ir = lower(
    parseSpec(
      "name: hello-test\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: |\n    You are a helpful, concise assistant.\n",
    ),
  );
  if (ir.target !== "cli") throw new Error("expected cli");
  const samples: Sample[] = [
    { id: "q1", input: "What is 2+2?", expected_output: "4" },
    { id: "q2", input: "What is 5-3?", expected_output: "2" },
    { id: "q3", input: "What is 6/2?", expected_output: "3", metadata: { difficulty: "hard" } },
  ];
  async function* yieldSamples(): AsyncIterable<Sample> {
    for (const s of samples) yield s;
  }
  // A pass, a fail and an errored case: every bucket a state-free run has.
  const invoker: AgentInvoker = async ({ sample }) => {
    if (sample.id === "q3") throw new Error("provider down");
    return {
      agentOutput: sample.id === "q2" ? "wrong" : (sample.expected_output ?? ""),
      transcript: [],
      events: [],
    };
  };
  const { compiled } = parseGradersConfig("graders:\n  - name: math\n    type: exact_match\n");
  const summary = await runEval({
    ir,
    dataset: { name: "fixture3", samples: yieldSamples() },
    compiledGraders: compiled,
    opts: {
      invoker,
      outDir,
      concurrency: 1,
      runId: "run_fixture",
      datasetHash: "d".repeat(64),
      gradersHash: "g".repeat(64),
      cliVersion: "0.8.2",
      seed: 7,
    },
  });
  const results = JSON.parse(readFileSync(join(outDir, "results.json"), "utf8"));
  expect(JSON.stringify(blank(results))).toBe(RESULTS_FIXTURE);
  const row = runIndexEntryFromSummary(summary, {
    specName: "hello-test",
    datasetHash: "d".repeat(64),
    outDir: "/abs/out",
  });
  expect(JSON.stringify(blank(row))).toBe(ROW_FIXTURE);
  const pin = pinFromIndexEntry(row, "2026-01-01T00:00:00.000Z");
  if (!pin.ok) throw new Error("expected a pin");
  expect(JSON.stringify(blank(pin.pin))).toBe(PIN_FIXTURE);
  // The run directory adds its case digests beside run.json, and nothing else.
  expect(readdirSync(outDir).sort()).toEqual([
    "cases.json",
    "q1",
    "q2",
    "q3",
    "results.json",
    "run.json",
  ]);
});
