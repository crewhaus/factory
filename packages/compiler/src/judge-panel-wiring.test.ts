/**
 * 0.6.0 §6.2 / §4.2 (PR 13b) — the LANDING of the last two
 * `model-plan-pending-runtime` classes.
 *
 * Before this PR two promises were still outstanding on `main`:
 *
 *   1. §6.2 — `evaluation.grader`'s `judges` / `repeats` / `temperature` /
 *      `target` (and a `kind: judge` gate's identical four) lowered into
 *      `IrEvaluation` / `IrJudge` while every judge CALL SITE still made a
 *      single-model `judge()` call, so a declared panel was inert.
 *   2. §4.2 — a `$profile` on an AUXILIARY slot lowered its pinned request
 *      params and no consumer read them.
 *
 * Both are wired now, so the compiler emits neither landing promise. These
 * tests pin that: a spec that declares EVERY one of those keys compiles with
 * an empty pending-runtime warning set, the knobs reach the emitted bundle,
 * and a spec declaring none of them emits the same bytes as before.
 */
import { describe, expect, test } from "bun:test";
import { parseSpec, parseSpecIssues } from "@crewhaus/spec";
import { compile, lower } from "./index";

const opts = { today: "2026-09-04" } as const;

const REGISTRY = [
  "models:",
  "  fast: { model: claude-haiku-4-5, tags: [cheap], max_tokens: 4096 }",
  "  strong: { model: claude-opus-4-8, tags: [strong] }",
  "  checker: { model: claude-sonnet-4-6, max_tokens: 512, thinking: { effort: low } }",
];

/** Every §6.2 panel knob and every §4.2 auxiliary slot, on one cli spec. */
const EVERYTHING = [
  "name: hello",
  "target: cli",
  ...REGISTRY,
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: be helpful",
  "tools: [read]",
  "compaction: { model: $checker }",
  "security: { justification: { judge: claude, model: $checker } }",
  "budget: { usd: 1, on_exceed: { action: degrade, model: $fast } }",
  "watchme: { judge: { model: $checker } }",
  "evaluation:",
  "  grader:",
  "    type: llm_judge",
  "    criteria: helpful",
  "    judges: [$checker, $strong]",
  "    repeats: 3",
  "    temperature: 0.2",
  "    target: transcript",
].join("\n");

describe("PR 13b — nothing this PR wires pends any more", () => {
  test("a spec declaring every panel knob and every aux slot compiles with an EMPTY pending set", () => {
    expect(parseSpecIssues(EVERYTHING)).toEqual([]);
    const result = compile(EVERYTHING, opts);
    expect(result.warnings.filter((w) => w.code === "model-plan-pending-runtime")).toEqual([]);
    // …and the landing sentences themselves are gone from the compiler's
    // vocabulary, not merely unreachable on this spec.
    const messages = result.warnings.map((w) => w.message).join("\n");
    expect(messages).not.toContain("judge-panel wiring");
    expect(messages).not.toContain("per-slot params consumers");
  });

  test("the panel knobs and the judge profile's params reach the emitted cli bundle", () => {
    const agent = compile(EVERYTHING, opts).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain(
      'import { gradeWithJudgePanel, inLoopRunResult } from "@crewhaus/eval-judge";',
    );
    expect(agent).toContain('judges: ["claude-sonnet-4-6", "claude-opus-4-8"],');
    expect(agent).toContain("repeats: 3,");
    expect(agent).toContain("temperature: 0.2,");
    expect(agent).toContain('target: "transcript",');
    // The `judges` panel names the INSTRUMENT declaratively too.
    expect(agent).toContain('judgeModel: "claude-sonnet-4-6+claude-opus-4-8",');
    // §4.2 — the compaction slot's profile params ride beside its model.
    expect(agent).toContain('compactionModel: "claude-sonnet-4-6",');
    expect(agent).toContain('compactionParams: {"thinking":{"effort":"low"},"maxTokens":512},');
    // …and the degrade rung's, inside the budget literal.
    expect(agent).toContain('"params":{"maxTokens":4096}');
  });

  test("a spec declaring NONE of them emits no panel field beyond the judge model", () => {
    const plain = [
      "name: hello",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: be helpful",
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful }",
    ].join("\n");
    const agent = compile(plain, opts).files.find((f) => f.path === "agent.ts")?.content ?? "";
    // The panel call carries exactly one field beyond the run: the model.
    expect(agent).toContain(
      '      run: inLoopRunResult({ finalText, messages, isSynthetic }),\n      model: "claude-sonnet-4-6",\n      // Judge spend rides',
    );
    expect(agent).not.toContain("judges:");
    expect(agent).not.toContain("repeats:");
    expect(agent).not.toContain("temperature:");
    expect(agent).not.toContain('target: "');
    expect(agent).not.toContain("params:");
    expect(agent).not.toContain("compactionParams");
  });
});

describe("PR 13b — the judge-gate shapes carry the same knobs", () => {
  const WORKFLOW = [
    "name: w",
    "target: workflow",
    ...REGISTRY,
    "model: claude-sonnet-4-6",
    "steps:",
    "  - name: draft",
    "    instructions: write",
    "  - name: gate",
    "    kind: judge",
    "    judge: { criteria: good, model: $checker, repeats: 3, target: transcript }",
  ].join("\n");

  test("a workflow judge gate renders the panel knobs onto its __judgeGate call", () => {
    const result = compile(WORKFLOW, opts);
    expect(result.warnings.filter((w) => w.code === "model-plan-pending-runtime")).toEqual([]);
    const bundle = result.files.map((f) => f.content).join("\n");
    expect(bundle).toContain("const result = await gradeWithJudgePanel({");
    expect(bundle).toContain("repeats: 3,");
    expect(bundle).toContain('target: "transcript",');
    expect(bundle).toContain('params: {"thinking":{"effort":"low"},"maxTokens":512},');
  });

  test("a graph judge gate renders them too", () => {
    const graph = [
      "name: g",
      "target: graph",
      ...REGISTRY,
      "model: claude-sonnet-4-6",
      "nodes:",
      "  draft: { instructions: write }",
      "  gate:",
      "    kind: judge",
      "    judge: { criteria: good, judges: [$checker, $strong], temperature: 0.1 }",
      "edges:",
      "  - { from: draft, to: gate }",
      "entry: draft",
    ].join("\n");
    const result = compile(graph, opts);
    expect(result.warnings.filter((w) => w.code === "model-plan-pending-runtime")).toEqual([]);
    const bundle = result.files.map((f) => f.content).join("\n");
    expect(bundle).toContain('judges: ["claude-sonnet-4-6", "claude-opus-4-8"],');
    expect(bundle).toContain("temperature: 0.1,");
  });

  test("a gate with no panel knobs renders only its model (byte-identity)", () => {
    const plain = [
      "name: w",
      "target: workflow",
      "model: claude-sonnet-4-6",
      "steps:",
      "  - name: draft",
      "    instructions: write",
      "  - name: gate",
      "    kind: judge",
      "    judge: { criteria: good }",
    ].join("\n");
    const bundle = compile(plain, opts)
      .files.map((f) => f.content)
      .join("\n");
    // The gate's CALL SITE names only the model (the helper's own signature
    // always declares the optional knobs).
    expect(bundle).toContain(
      '        criteria: "good",\n        model: "claude-sonnet-4-6",\n        gatedTask:',
    );
  });
});

describe("PR 13b — browser grounding params", () => {
  const BROWSER = [
    "name: b",
    "target: browser",
    ...REGISTRY,
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: browse",
    "groundingModel: $checker",
    "driver: { backend: chromium, viewport: { width: 800, height: 600 } }",
  ].join("\n");

  test("the grounding slot's profile params lower and reach the emitted bundle", () => {
    const ir = lower(parseSpec(BROWSER), opts);
    if (ir.target !== "browser") throw new Error("unexpected target");
    expect(ir.groundingParams).toEqual({ thinking: { effort: "low" }, maxTokens: 512 });
    const result = compile(BROWSER, opts);
    expect(result.warnings.filter((w) => w.code === "model-plan-pending-runtime")).toEqual([]);
    const bundle = result.files.map((f) => f.content).join("\n");
    expect(bundle).toContain(
      'const SPEC_GROUNDING_PARAMS = {"thinking":{"effort":"low"},"maxTokens":512};',
    );
    expect(bundle).toContain("params: SPEC_GROUNDING_PARAMS");
  });

  test("a grounding slot with no profile emits no params const (byte-identity)", () => {
    const plain = [
      "name: b",
      "target: browser",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: browse",
      "driver: { backend: chromium, viewport: { width: 800, height: 600 } }",
    ].join("\n");
    const bundle = compile(plain, opts)
      .files.map((f) => f.content)
      .join("\n");
    expect(bundle).not.toContain("SPEC_GROUNDING_PARAMS");
    expect(bundle).toContain("createFindElementTool({ driver, model: SPEC_GROUNDING_MODEL })");
  });
});
