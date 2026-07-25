/**
 * NEW-graders-2/3 × A11 — the exam runner's `llm_judge` dispatch, pinned
 * with a REAL eval-judge stack over a stub provider adapter (no network):
 * categorical rubrics grade label-based pass/fail through `run_exam`
 * exactly like `runEval`, and `target: transcript` threads through both
 * the categorical and scalar branches (the judge sees the trajectory
 * framing, not the bare output).
 *
 * The stub rides `mock.module("@crewhaus/model-router")` — `judge`/
 * `judgeCategorical` resolve their adapter through `resolveModel` when the
 * caller injects none (the exam path never does), so this is the narrowest
 * seam that leaves every eval-judge line real. `mock.module` is
 * process-global and does NOT auto-restore across test files, so this
 * lives in its own file and `afterAll` restores a `{ ...ns }` SNAPSHOT of
 * the real module (the namespace itself is a live view that would resolve
 * to the stub after patching).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";

/** Every judge request the stub served: tool name + the exact user text,
 *  so target-threading is assertable on the prompt the judge really saw. */
const served: Array<{ tool: string; userText: string }> = [];

/** A synthetic ProviderAdapter answering the FORCED judge tool call —
 *  `submit_label` (categorical) or `submit_score` (scalar) — with a
 *  verdict computed from the exact user text the judge saw. */
function stubJudgeAdapter(
  verdictFor: (userText: string, tool: string) => Record<string, unknown>,
): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      const tool = req.tools?.[0]?.name ?? "submit_score";
      const userMsg = req.messages.find((m) => m.role === "user");
      const userText =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : (userMsg?.content
              ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n") ?? "");
      served.push({ tool, userText });
      const verdict = verdictFor(userText, tool);
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu_stub", name: tool, input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use" };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** The active stub — tests swap the verdict function per case. */
let verdictFn: (userText: string, tool: string) => Record<string, unknown> = () => ({
  label: "correct",
  rationale: "stub default",
});

// Snapshot BEFORE mocking (a live namespace would restore the stub itself).
const realModelRouter = { ...(await import("@crewhaus/model-router")) };

mock.module("@crewhaus/model-router", () => ({
  ...realModelRouter,
  resolveModel: async (model: string) => ({
    adapter: stubJudgeAdapter((userText, tool) => verdictFn(userText, tool)),
    modelId: model,
    providerId: "anthropic",
  }),
}));

const { createExamRunner } = await import("./exam");

afterAll(() => {
  mock.module("@crewhaus/model-router", () => realModelRouter);
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "exam-judge-"));
  served.length = 0;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const CATEGORICAL_RUBRIC = `      kind: categorical
      labels:
        - name: correct
          score: 1
          description: matches the gold
        - name: wrong
          score: 0
          description: does not match
      passing_labels: [correct]
`;

function writeFixture(gradersYaml: string): { datasetPath: string; gradersPath: string } {
  const evalDir = join(tmp, "eval");
  mkdirSync(evalDir, { recursive: true });
  const datasetPath = join(evalDir, "dataset.jsonl");
  writeFileSync(
    datasetPath,
    `${JSON.stringify({ id: "q1", input: "meaning of life?" })}\n${JSON.stringify({
      id: "q2",
      input: "airspeed of a swallow?",
    })}\n`,
  );
  const gradersPath = join(evalDir, "graders.yaml");
  writeFileSync(gradersPath, gradersYaml);
  return { datasetPath, gradersPath };
}

function runnerOpts(overrides: Partial<Parameters<typeof createExamRunner>[0]> = {}) {
  return {
    specName: "expert",
    model: "claude-haiku-4-5",
    instructions: "You are an expert.",
    fragment: { specName: "expert" },
    cwd: tmp,
    // Deterministic examinee: q1 answers 42, q2 bluffs.
    invoker: async ({ sample }: { sample: { id: string } }) => ({
      agentOutput: sample.id === "q1" ? "the answer is 42" : "no idea, maybe blue?",
    }),
    outDir: join(tmp, "exam-out"),
    ...overrides,
  };
}

describe("createExamRunner × llm_judge dispatch (real eval-judge, stub adapter)", () => {
  test("a categorical rubric grades label-based pass/fail (NEW-graders-2)", async () => {
    const { datasetPath, gradersPath } = writeFixture(
      `graders:
  - name: label_check
    type: llm_judge
    rubric:
${CATEGORICAL_RUBRIC}`,
    );
    verdictFn = (userText) =>
      userText.includes("42")
        ? { label: "correct", rationale: "saw the gold" }
        : { label: "wrong", rationale: "bluffing" };
    const runner = createExamRunner(runnerOpts());
    const report = await runner({ datasetPath, gradersPath });

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    // The judge was forced onto submit_label (categorical dispatch, not a
    // scalar submit_score call).
    expect(served.every((s) => s.tool === "submit_label")).toBe(true);
    const passed = report.outcomes.find((o) => o.passed);
    const failed = report.outcomes.find((o) => !o.passed);
    expect(passed?.sampleId).toBe("q1");
    expect(passed?.score).toBe(1);
    expect(passed?.rationale).toContain('judge label="correct"');
    expect(failed?.sampleId).toBe("q2");
    expect(failed?.score).toBe(0);
    expect(failed?.rationale).toContain('judge label="wrong"');
  });

  test("target: transcript threads through the categorical branch (NEW-graders-3)", async () => {
    const { datasetPath, gradersPath } = writeFixture(
      `graders:
  - name: label_check
    type: llm_judge
    target: transcript
    rubric:
${CATEGORICAL_RUBRIC}`,
    );
    verdictFn = () => ({ label: "correct", rationale: "trajectory fine" });
    const runner = createExamRunner(runnerOpts());
    await runner({ datasetPath, gradersPath });

    expect(served.length).toBe(2);
    for (const s of served) {
      // The judge saw the transcript framing + digest, not a bare output
      // block (the exam invoker records no transcript, so the digest
      // degrades behind its explicit marker).
      expect(s.tool).toBe("submit_label");
      expect(s.userText).toContain("Agent transcript");
      expect(s.userText).toContain("(no transcript recorded)");
    }
  });

  test("target: transcript threads through the scalar branch too", async () => {
    const { datasetPath, gradersPath } = writeFixture(
      `graders:
  - name: quality
    type: llm_judge
    target: transcript
    rubric:
      criteria:
        - name: c1
          description: sensible
          anchors: { 1: bad, 2: meh, 3: ok, 4: good, 5: great }
`,
    );
    verdictFn = () => ({
      score: 5,
      rationale: "trajectory fine",
      criterion_scores: { c1: 5 },
    });
    const runner = createExamRunner(runnerOpts());
    const report = await runner({ datasetPath, gradersPath });

    expect(report.passed).toBe(2);
    expect(served.length).toBe(2);
    for (const s of served) {
      expect(s.tool).toBe("submit_score");
      expect(s.userText).toContain("Agent transcript");
      expect(s.userText).toContain("(no transcript recorded)");
    }
  });
});
