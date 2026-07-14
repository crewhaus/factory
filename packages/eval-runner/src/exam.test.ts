/**
 * v0.3.0 Goal 2 (design §3.3 EXAM, PR 17) — `createExamRunner`:
 * dataset/graders loading with clear path errors, deterministic grading
 * (contains grader — no model), wiki-grounded invoker construction (pinned
 * via the injected chatLoop seam), report mapping (pass rate, failed items,
 * artifacts), and the failed-sample surface the `run_exam` tool logs gaps
 * from.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWikiStore } from "@crewhaus/wiki-store";
import { RunnerError } from "./errors";
import { EXAM_SESSION_PREAMBLE, type ExamChatLoopOptions, createExamRunner } from "./exam";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "exam-runner-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const DATASET = [
  { id: "q1", input: "What is extraction yield?", expected: "dissolved coffee mass" },
  { id: "q2", input: "What is the SCA golden-cup TDS range?", expected: "1.15-1.35%" },
]
  .map((s) => JSON.stringify(s))
  .join("\n");

/** Deterministic grader — no model call anywhere in the run. Passes when
 *  the answer cites a wiki slug (the grounded-not-bluffed check). */
const GRADERS = `graders:
  - name: cites_wiki
    type: contains
    substring: "(coffee/"
`;

function writeExamFiles(): { datasetPath: string; gradersPath: string } {
  const evalDir = join(tmp, "eval");
  mkdirSync(evalDir, { recursive: true });
  const datasetPath = join(evalDir, "dataset.jsonl");
  const gradersPath = join(evalDir, "graders.yaml");
  writeFileSync(datasetPath, `${DATASET}\n`);
  writeFileSync(gradersPath, GRADERS);
  return { datasetPath, gradersPath };
}

/** A deterministic mock "model": right on q1, bluffing on q2. */
function mockChatLoop(captured: ExamChatLoopOptions[]) {
  return async (opts: ExamChatLoopOptions): Promise<string> => {
    captured.push(opts);
    const question = opts.seedMessages[0]?.content ?? "";
    if (question.includes("extraction yield")) {
      return "Extraction yield is the fraction of dissolved coffee mass (coffee/extraction-yield).";
    }
    return "I believe it is around 8-12%."; // wrong — fails `contains`
  };
}

function runnerOpts(overrides: Partial<Parameters<typeof createExamRunner>[0]> = {}) {
  return {
    specName: "expert",
    model: "claude-haiku-4-5",
    instructions: "You are a specialty-coffee expert.",
    fragment: { specName: "expert", memory: { wiki: { enabled: true } } },
    cwd: tmp,
    ...overrides,
  };
}

describe("createExamRunner — grading + report (deterministic, no model)", () => {
  test("grades every sample, maps outcomes, and persists artifacts", async () => {
    const { datasetPath, gradersPath } = writeExamFiles();
    const captured: ExamChatLoopOptions[] = [];
    const runner = createExamRunner(
      runnerOpts({ chatLoop: mockChatLoop(captured), outDir: join(tmp, "exam-out") }),
    );
    const report = await runner({ datasetPath, gradersPath });

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBeCloseTo(0.5);
    const failed = report.outcomes.find((o) => !o.passed);
    expect(failed?.sampleId).toBe("q2");
    expect(failed?.input).toContain("golden-cup");
    expect(failed?.rationale).toContain("cites_wiki");
    expect(failed?.agentOutput).toContain("8-12%");

    // Per-sample artifacts + the exam report land on disk.
    expect(report.outDir).toBe(join(tmp, "exam-out"));
    expect(existsSync(join(tmp, "exam-out", "exam.json"))).toBe(true);
    expect(existsSync(join(tmp, "exam-out", "q1", "grades.json"))).toBe(true);
    expect(existsSync(join(tmp, "exam-out", "q2", "grades.json"))).toBe(true);
  });

  test("the exam session is the harness + exam preamble, wiki-grounded, zero tools", async () => {
    const { datasetPath, gradersPath } = writeExamFiles();
    // Seed the REAL wiki the exam must read (not an isolated per-sample one).
    const store = createWikiStore({ specName: "expert", rootDir: join(tmp, ".crewhaus", "wiki") });
    await store.write({
      slug: "extraction-yield",
      title: "Extraction yield",
      body: "The fraction of dissolved coffee mass.\n\n## Sources\n- SCA handbook",
      tags: ["fundamentals"],
    });

    const captured: ExamChatLoopOptions[] = [];
    const runner = createExamRunner(
      runnerOpts({ chatLoop: mockChatLoop(captured), outDir: join(tmp, "exam-out") }),
    );
    await runner({ datasetPath, gradersPath });

    expect(captured.length).toBe(2);
    const call = captured.find((c) => c.seedMessages[0]?.content.includes("extraction yield"));
    expect(call?.model).toBe("claude-haiku-4-5");
    expect(call?.instructions).toContain("You are a specialty-coffee expert.");
    expect(call?.instructions).toContain(EXAM_SESSION_PREAMBLE);
    expect(call?.singleTurn).toBe(true);
    expect(call?.sessionTarget).toBe("eval");
    expect(call?.tools).toEqual([]);
    // Wiki grounding rides the runtime's memory seam (classification +
    // delimiter escaping apply), seeded with the question itself.
    expect(call?.memory?.autoRecall).toBe(true);
    expect(call?.memory?.recallSeed).toBe("What is extraction yield?");
    const lines = await call?.memory?.recall("extraction yield", 6);
    expect(lines?.some((l) => l.includes("[wiki:extraction-yield]"))).toBe(true);
  });

  test("a missing graders file names the learning.exam.graders path", async () => {
    const { datasetPath } = writeExamFiles();
    const runner = createExamRunner(runnerOpts({ chatLoop: mockChatLoop([]) }));
    expect(runner({ datasetPath, gradersPath: join(tmp, "eval", "nope.yaml") })).rejects.toThrow(
      /learning\.exam\.graders/,
    );
  });

  test("a missing dataset names the learning.exam.dataset path", async () => {
    const { gradersPath } = writeExamFiles();
    const runner = createExamRunner(runnerOpts({ chatLoop: mockChatLoop([]) }));
    expect(runner({ datasetPath: join(tmp, "eval", "nope.jsonl"), gradersPath })).rejects.toThrow(
      /learning\.exam\.dataset/,
    );
  });

  test("an empty dataset is refused loudly", async () => {
    const { gradersPath } = writeExamFiles();
    const emptyPath = join(tmp, "eval", "empty.jsonl");
    writeFileSync(emptyPath, "");
    const runner = createExamRunner(runnerOpts({ chatLoop: mockChatLoop([]) }));
    expect(runner({ datasetPath: emptyPath, gradersPath })).rejects.toThrow(RunnerError);
    expect(runner({ datasetPath: emptyPath, gradersPath })).rejects.toThrow(/zero samples/);
  });

  test("an invoker error becomes a failed outcome with the error surfaced", async () => {
    const { datasetPath, gradersPath } = writeExamFiles();
    const runner = createExamRunner(
      runnerOpts({
        invoker: async () => {
          throw new Error("provider timeout");
        },
        outDir: join(tmp, "exam-err"),
      }),
    );
    const report = await runner({ datasetPath, gradersPath });
    expect(report.passed).toBe(0);
    expect(report.outcomes.every((o) => !o.passed)).toBe(true);
    expect(report.outcomes[0]?.error).toContain("provider timeout");
  });
});
