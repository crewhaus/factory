import { describe, expect, test } from "bun:test";
import type { IrWorkflowStep, IrWorkflowV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerWorkflow } from "./index";

const step = (over: Partial<IrWorkflowStep> = {}): IrWorkflowStep => ({
  name: "research",
  instructions: "You are a research assistant.",
  model: "claude-haiku-4-5-20251001",
  tools: [],
  toolConfigs: Object.freeze({}),
  ...over,
});

const baseIr: IrWorkflowV0 = {
  version: 0,
  name: "summarize-flow",
  target: "workflow",
  steps: [
    step({ name: "research", instructions: "Research the topic thoroughly." }),
    step({
      name: "draft",
      instructions: "Draft a summary from the research.",
      model: "claude-sonnet-4-5-20250929",
    }),
    step({
      name: "polish",
      instructions: "Polish the draft into final prose.",
      model: "claude-opus-4-5-20250101",
    }),
  ],
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

describe("emitCfWorkerWorkflow", () => {
  test("emits worker.js, wrangler.toml, package.json, and the generated README (item 42)", () => {
    const bundle = emitCfWorkerWorkflow(baseIr);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "package.json", "worker.js", "wrangler.toml"]);
    const readme = bundle.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("wrangler deploy");
  });

  test("readme: false restores the three-file bundle (item 42 opt-out)", () => {
    const bundle = emitCfWorkerWorkflow(baseIr, { readme: false });
    expect(bundle.files.map((f) => f.path).sort()).toEqual([
      "package.json",
      "worker.js",
      "wrangler.toml",
    ]);
  });

  test("worker.js inlines each step's model and instructions and the Anthropic endpoint", () => {
    const bundle = emitCfWorkerWorkflow(baseIr);
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker?.content).toContain("api.anthropic.com");
    for (const s of baseIr.steps) {
      expect(worker?.content).toContain(s.model);
      expect(worker?.content).toContain(s.instructions);
      expect(worker?.content).toContain(s.name);
    }
  });

  test("worker.js threads the prior step's output into later steps", () => {
    const worker = emitCfWorkerWorkflow(baseIr).files.find((f) => f.path === "worker.js");
    // The synthetic framing for steps 2..N (mirrors target-workflow).
    expect(worker?.content).toContain("## Output of previous step:");
    // Empty user input falls back to "begin" like the local workflow target.
    expect(worker?.content).toContain("begin");
  });

  test("wrangler.toml uses sanitized spec name", () => {
    const ir: IrWorkflowV0 = { ...baseIr, name: "Summarize Flow!" };
    const bundle = emitCfWorkerWorkflow(ir);
    const wrangler = bundle.files.find((f) => f.path === "wrangler.toml");
    expect(wrangler?.content).toContain('name = "summarize-flow-"');
  });

  test("worker.js escapes special characters in instructions", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      steps: [step({ instructions: 'Respond with "quoted" text\nand newlines.' })],
    };
    const bundle = emitCfWorkerWorkflow(ir);
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker?.content).toContain('\\"quoted\\"');
    expect(worker?.content).toContain("\\n");
  });

  test("rejects non-workflow IR variants", () => {
    const wrong = { ...baseIr, target: "cli" } as unknown as IrWorkflowV0;
    expect(() => emitCfWorkerWorkflow(wrong)).toThrow(TargetEmitError);
  });

  test("rejects steps with tools until M2+", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      steps: [step({ name: "research" }), step({ name: "draft", tools: ["read", "write"] })],
    };
    expect(() => emitCfWorkerWorkflow(ir)).toThrow(TargetEmitError);
  });

  // Regression: the cli emitter previously wrapped JSON.stringify output in an
  // extra pair of quotes (`name: ""x""`), which Cloudflare rejected at upload
  // with "Unexpected identifier". The substring assertions above miss it, so
  // parse the whole module instead.
  const parseJs = (code: string) => new Bun.Transpiler({ loader: "js" }).transformSync(code);

  test("worker.js is syntactically valid JavaScript", () => {
    const worker = emitCfWorkerWorkflow(baseIr).files.find((f) => f.path === "worker.js");
    expect(() => parseJs(worker?.content ?? "")).not.toThrow();
  });

  test("worker.js stays valid with hyphenated name and tricky instructions", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      name: "summarize-flow",
      steps: [
        step({
          name: "tricky-step",
          instructions: 'Quotes "here", a newline\nhere, a ${dollar} and a ` backtick.',
        }),
        step({ name: "second-step", instructions: "Plain second step." }),
      ],
    };
    const worker = emitCfWorkerWorkflow(ir).files.find((f) => f.path === "worker.js");
    expect(() => parseJs(worker?.content ?? "")).not.toThrow();
  });
});

describe("emitCfWorkerWorkflow — package.json name injection (#148)", () => {
  test("package.json sanitizes the spec name and resists JSON injection", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      name: '", "dependencies": { "evil-typosquat": "1.0.0" }, "x": "',
    };
    const pkg = emitCfWorkerWorkflow(ir).files.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    const parsed = JSON.parse(pkg?.content ?? "") as {
      name: string;
      dependencies?: Record<string, string>;
    };
    expect(parsed.name).not.toContain('"'); // sanitized to [a-z0-9-]
    expect(parsed.dependencies).toBeUndefined(); // injection did not break out
  });
});

describe("emitCfWorkerWorkflow — provider gate", () => {
  test("a workflow with one openai/ step fails at compile time, naming the step", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      steps: [step({ name: "research" }), step({ name: "draft", model: "openai/gpt-4o-mini" })],
    };
    expect(() => emitCfWorkerWorkflow(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerWorkflow(ir)).toThrow(
      /cf-worker targets currently support claude-\* models only — use the cli target for other providers/,
    );
    expect(() => emitCfWorkerWorkflow(ir)).toThrow(/step "draft"/);
  });

  test("gemini/, bedrock/, and local/ step models are all rejected", () => {
    for (const model of [
      "gemini/gemini-2.5-flash",
      "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "local/llama3.2@http://localhost:11434/v1",
    ]) {
      const ir: IrWorkflowV0 = { ...baseIr, steps: [step({ model })] };
      expect(() => emitCfWorkerWorkflow(ir)).toThrow(TargetEmitError);
    }
  });

  test("all-claude steps still emit cleanly", () => {
    expect(emitCfWorkerWorkflow(baseIr).files.length).toBe(4);
  });
});

describe("emitCfWorkerWorkflow — failure_taxonomy ignored-note (item 23)", () => {
  test("worker.js carries the ignored-taxonomy note when the spec declares one", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    };
    const code = emitCfWorkerWorkflow(ir).files[0]?.content ?? "";
    expect(code).toContain(
      "failure_taxonomy configured but target-cf-worker-workflow does not yet wire it up",
    );
  });

  test("no note when the spec omits failure_taxonomy", () => {
    expect(emitCfWorkerWorkflow(baseIr).files[0]?.content ?? "").not.toContain(
      "failure_taxonomy configured",
    );
  });
});
