import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lower } from "@crewhaus/compiler";
import { type Sample, loadDataset } from "@crewhaus/eval-dataset";
import { parseGradersConfig, runCriteriaRecord } from "@crewhaus/eval-grader";
import { hashDatasetFile, recordEvalRun } from "@crewhaus/eval-report";
import { runEval } from "@crewhaus/eval-runner";
import { parseSpec } from "@crewhaus/spec";
import { CRITERIA_HISTORY_REL, gradersRevision, runCriteriaCommand } from "./criteria-cmd";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

const SPEC = `name: shop
target: cli
agent:
  model: m
  instructions: Answer.
evaluation:
  grader: { type: regex, value: "." }
  on_fail: note
  protected: true
`;

const GRADERS = `# shop graders
graders:
  - name: exact
    type: exact_match
  - name: has
    type: contains
    substring: a
criteria:
  - id: answers-match
    title: Answers match
    protected: true
    owner: maintainers
    description: The answer is the expected one.
    measured_by: [exact]
`;

const DATASET = [
  { id: "c1", input: "q1", expected_output: "a1", metadata: { family: "csv" } },
  { id: "j1", input: "q2", expected_output: "b2", metadata: { family: "json" } },
];

/** A harness directory with a spec, a graders file and a dataset. */
function harness(graders = GRADERS): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-criteria-cmd-"));
  TMP.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), SPEC);
  mkdirSync(join(dir, "eval"));
  writeFileSync(join(dir, "eval", "graders.yaml"), graders);
  writeFileSync(
    join(dir, "eval", "dataset.jsonl"),
    `${DATASET.map((d) => JSON.stringify(d)).join("\n")}\n`,
  );
  return dir;
}

/** A recorded live run of the harness, as `crewhaus eval` leaves it. */
async function recordRun(dir: string): Promise<string> {
  const ir = lower(parseSpec(SPEC));
  if (ir.target !== "cli") throw new Error("cli");
  const { compiled, config } = parseGradersConfig(
    readFileSync(join(dir, "eval", "graders.yaml"), "utf8"),
  );
  const datasetPath = join(dir, "eval", "dataset.jsonl");
  const loaded = await loadDataset(datasetPath);
  const datasetHash = hashDatasetFile(datasetPath);
  const criteria = runCriteriaRecord(config);
  const evalsDir = join(dir, ".crewhaus", "evals");
  const summary = await runEval({
    ir,
    dataset: { name: loaded.name, samples: loaded.samples },
    compiledGraders: compiled,
    opts: {
      outDir: join(evalsDir, "run_src00001"),
      runId: "run_src00001",
      datasetHash,
      ...(criteria !== undefined ? { criteria } : {}),
      readCalibrationFile: () => undefined,
      invoker: async ({ sample }: { sample: Sample }) => ({
        agentOutput: sample.expected_output ?? "",
      }),
    },
  });
  recordEvalRun(summary, {
    specName: "shop",
    datasetHash,
    outDir: resolve(summary.outDir),
    evalsDir,
  });
  return summary.runId;
}

const run = (dir: string, argv: string[], extra: Parameters<typeof runCriteriaCommand>[1] = {}) =>
  runCriteriaCommand(argv, { cwd: dir, now: () => Date.parse("2026-11-12T10:00:00Z"), ...extra });

const editsFile = (dir: string, edits: unknown[]): string => {
  const path = join(dir, `edits-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(edits));
  return path;
};

describe("criteria list", () => {
  test("declared, implicit and in-spec criteria, with the revision apply takes", async () => {
    const dir = harness();
    const out = await run(dir, ["list"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toContain(`revision ${gradersRevision(GRADERS)}`);
    const text = out.lines.join("\n");
    expect(text).toContain("answers-match — Answers match  enforce  protected  deterministic");
    expect(text).toContain("edited outside Home");
    expect(text).toContain("grader:has  enforce  deterministic");
    expect(text).toContain("spec:evaluation  observing  protected  deterministic");
    const json = JSON.parse((await run(dir, ["list", "--json"])).lines.join("\n"));
    expect(json.revision).toBe(gradersRevision(GRADERS));
    expect(json.criteria.map((r: { id: string }) => r.id)).toEqual([
      "answers-match",
      "grader:has",
      "spec:evaluation",
    ]);
  });
});

describe("criteria apply", () => {
  test("a stale --expect writes nothing and prints the current revision", async () => {
    const dir = harness();
    const edits = editsFile(dir, [
      { op: "setText", id: "answers-match", field: "title", value: "T" },
    ]);
    const out = await run(dir, ["apply", edits, "--expect", "sha256:0000"]);
    expect(out.exitCode).toBe(1);
    expect(out.lines.join("\n")).toContain(`current revision: ${gradersRevision(GRADERS)}`);
    expect(readFileSync(join(dir, "eval", "graders.yaml"), "utf8")).toBe(GRADERS);
  });

  test("--expect is required", async () => {
    const dir = harness();
    const edits = editsFile(dir, []);
    await expect(run(dir, ["apply", edits])).rejects.toThrow(/--expect <revision> is required/);
  });

  test("applies in place, keeps the file's mode and comments, and logs each changed criterion", async () => {
    const dir = harness();
    const path = join(dir, "eval", "graders.yaml");
    chmodSync(path, 0o640);
    const edits = editsFile(dir, [
      { op: "setText", id: "answers-match", field: "title", value: "Answers match exactly" },
    ]);
    const out = await run(dir, ["apply", edits, "--expect", gradersRevision(GRADERS)], {
      ownerCheck: () => ({ ok: true }),
    });
    expect(out.exitCode).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("title: Answers match exactly");
    expect(after).toContain("# shop graders");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    const lines = readFileSync(join(dir, CRITERIA_HISTORY_REL), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] as string);
    expect(Object.keys(line)).toEqual(["criterion", "digest", "at", "cmd"]);
    expect(line).toMatchObject({
      criterion: "answers-match",
      at: "2026-11-12T10:00:00.000Z",
      cmd: "crewhaus criteria apply",
    });
    expect(line.digest).toMatch(/^[0-9a-f]{64}$/);
    // The new digest now reads as a recorded revision.
    expect((await run(dir, ["list"])).lines.join("\n")).toContain("r1");
  });

  test("loosening a protected criterion without --confirm writes nothing", async () => {
    const dir = harness();
    const edits = editsFile(dir, [{ op: "setMode", id: "answers-match", value: "observe" }]);
    const out = await run(dir, ["apply", edits, "--expect", gradersRevision(GRADERS)], {
      ownerCheck: () => ({ ok: true }),
    });
    expect(out.exitCode).toBe(1);
    expect(out.lines.join("\n")).toContain("answers-match: it moves from enforcing to observing");
    expect(out.lines.join("\n")).toContain("--confirm shop");
    expect(readFileSync(join(dir, "eval", "graders.yaml"), "utf8")).toBe(GRADERS);
  });

  test("with --confirm it still needs the owner, and records who when it has them", async () => {
    const dir = harness();
    const edits = editsFile(dir, [{ op: "setMode", id: "answers-match", value: "observe" }]);
    const refused = await run(
      dir,
      ["apply", edits, "--expect", gradersRevision(GRADERS), "--confirm", "shop"],
      { ownerCheck: () => ({ ok: false, reason: "the list of who may approve cannot be read" }) },
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join("\n")).toContain("needs this harness's owner");
    expect(readFileSync(join(dir, "eval", "graders.yaml"), "utf8")).toBe(GRADERS);
    const done = await run(
      dir,
      ["apply", edits, "--expect", gradersRevision(GRADERS), "--confirm", "shop"],
      { ownerCheck: () => ({ ok: true, principal: "prn_owner" }) },
    );
    expect(done.exitCode).toBe(0);
    const line = JSON.parse(readFileSync(join(dir, CRITERIA_HISTORY_REL), "utf8").trim());
    expect(Object.keys(line)).toEqual(["criterion", "digest", "at", "cmd", "by"]);
    expect(line.by).toBe("prn_owner");
  });

  test("the history is never appended through a link at its file", async () => {
    const dir = harness();
    const outside = join(mkdtempSync(join(tmpdir(), "crewhaus-criteria-outside-")), "log");
    TMP.push(dirname(outside));
    writeFileSync(outside, "");
    mkdirSync(dirname(join(dir, CRITERIA_HISTORY_REL)), { recursive: true });
    symlinkSync(outside, join(dir, CRITERIA_HISTORY_REL));
    const edits = editsFile(dir, [
      { op: "setText", id: "answers-match", field: "title", value: "T" },
    ]);
    const out = await run(dir, ["apply", edits, "--expect", gradersRevision(GRADERS)], {
      ownerCheck: () => ({ ok: true }),
    });
    expect(out.exitCode).toBe(1);
    expect(out.lines.join("\n")).toContain("could not record its history");
    expect(readFileSync(outside, "utf8")).toBe("");
  });

  test("an edits file that is not a list of edits is refused", async () => {
    const dir = harness();
    const edits = editsFile(dir, [{ op: "deleteEverything" }]);
    await expect(run(dir, ["apply", edits, "--expect", gradersRevision(GRADERS)])).rejects.toThrow(
      /not a list of criteria edits/,
    );
  });
});

describe("criteria lint", () => {
  test("names what is unsaid and what matches no case; a warning exits 1", async () => {
    const dir = harness(`graders:
  - { name: exact, type: exact_match }
  - { name: has, type: contains, substring: a }
criteria:
  - id: guarded
    protected: true
    measured_by: [exact]
  - id: watching
    mode: observe
    scope: { metadata: { family: [xml] } }
    measured_by: [has]
`);
    const out = await run(dir, ["lint", "--dataset", "eval/dataset.jsonl", "--json"]);
    expect(out.exitCode).toBe(1);
    const rules = JSON.parse(out.lines.join("\n")).findings.map(
      (f: { rule: string; subject: string }) => `${f.rule}:${f.subject}`,
    );
    expect(rules).toEqual([
      "protected-without-owner:guarded",
      "no-description:guarded",
      "no-description:watching",
      "observe-without-cases:watching",
    ]);
  });

  test("a scope that matches nothing, and an unbound grader as information", async () => {
    const dir = harness(`graders:
  - { name: exact, type: exact_match }
  - { name: has, type: contains, substring: a }
criteria:
  - id: xml-only
    description: d
    scope: { metadata: { family: [xml] } }
    measured_by: [exact]
`);
    const out = await run(dir, ["lint", "--dataset", "eval/dataset.jsonl"]);
    expect(out.lines.join("\n")).toContain("warn scope-matches-nothing: criterion xml-only");
    expect(out.lines.join("\n")).toContain("info unbound-grader: grader has");
    expect(out.exitCode).toBe(1);
    const clean = harness();
    expect((await run(clean, ["lint"])).exitCode).toBe(0);
  });
});

describe("criteria show", () => {
  test("the criterion, its revisions and its last results", async () => {
    const dir = harness();
    const runId = await recordRun(dir);
    const view = JSON.parse((await run(dir, ["show", "answers-match", "--json"])).lines.join("\n"));
    expect(view.run).toBe(runId);
    expect(view.results.exact).toEqual({
      pass: 2,
      fail: 0,
      notMeasured: 0,
      skipped: 0,
      observing: 0,
      wouldFail: 0,
    });
    expect(view.graders).toEqual([
      { name: "exact", kind: "deterministic", digest: expect.any(String) },
    ]);
    await expect(run(dir, ["show", "nope"])).rejects.toThrow(/no criterion "nope"/);
  });
});

describe("criteria preview", () => {
  test("an edit that would call a judge says how many calls, cost unknown when unpriced, and stops", async () => {
    const dir = harness(
      GRADERS.replace(
        "criteria:",
        `  - name: judge
    type: llm_judge
    rubric:
      criteria:
        - name: q
          description: is it right
          anchors: { "1": a, "2": b, "3": c, "4": d, "5": e }
criteria:`,
      ),
    );
    await recordRun(dir);
    let regraded = 0;
    const edits = editsFile(dir, [
      { op: "addCriterion", criterion: { id: "judged", mode: "observe", measured_by: ["judge"] } },
    ]);
    const out = await run(dir, ["preview", edits, "--dataset", "eval/dataset.jsonl"], {
      regrade: async () => {
        regraded++;
        throw new Error("not reached");
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.lines.join("\n")).toContain("would make 2 judge call(s), cost unknown");
    expect(out.lines.join("\n")).toContain("add --yes");
    expect(regraded).toBe(0);
  });

  test("a deterministic edit regrades the recorded answers and names each changed verdict", async () => {
    const dir = harness();
    await recordRun(dir);
    const edits = editsFile(dir, [{ op: "bind", id: "answers-match", grader: "has" }]);
    const out = await run(dir, ["preview", edits, "--dataset", "eval/dataset.jsonl", "--json"]);
    expect(out.exitCode).toBe(0);
    const view = JSON.parse(out.lines.join("\n"));
    expect(view.run).toBe("run_src00001");
    expect(view.judgeCalls).toBe(0);
    // Binding an enforced grader to an enforcing criterion grades as before.
    expect(view.changes).toEqual([]);
    expect(view.nextGate).toBe("no baseline to compare");
    // The graders file is untouched by a preview.
    expect(readFileSync(join(dir, "eval", "graders.yaml"), "utf8")).toBe(GRADERS);
  });

  test("a scope edit moves a verdict to skipped", async () => {
    const dir = harness(`graders:
  - { name: exact, type: exact_match }
criteria:
  - id: answers-match
    measured_by: [exact]
`);
    await recordRun(dir);
    const edits = editsFile(dir, [
      { op: "setScope", id: "answers-match", value: { metadata: { family: ["csv"] } } },
    ]);
    const out = await run(dir, ["preview", edits, "--dataset", "eval/dataset.jsonl"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toContain("j1: pass → skipped");
  });
});
