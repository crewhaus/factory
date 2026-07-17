import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrWorkflowStep, IrWorkflowV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerWorkflow } from "./index";

/**
 * SSE-frame test harness (Batch C, item 3). Executes the emitted worker
 * in-process against a stubbed Anthropic endpoint (streaming for the final
 * step, non-streaming JSON for intermediate steps) and collects the SSE frames
 * the worker's `/chat` returns, so the tests pin the real wire bytes.
 */
type SseEvent = { readonly name: string; readonly data: Record<string, unknown> };

function anthropicStreamBody(opts: {
  input: number;
  output: number;
  text: string;
  stopReason: string;
}): ReadableStream<Uint8Array> {
  const frames = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        usage: { input_tokens: opts.input, output_tokens: 1, cache_read_input_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: opts.text },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: opts.stopReason },
      usage: { output_tokens: opts.output },
    })}\n\n`,
    "event: message_stop\ndata: {}\n\n",
  ];
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

/** Stub Anthropic: JSON for `stream:false` intermediate steps, SSE for the final. */
function installAnthropicStub(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { stream?: boolean };
    if (body.stream) {
      return new Response(
        anthropicStreamBody({ input: 10, output: 5, text: "Final.", stopReason: "end_turn" }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "intermediate output" }],
        usage: { input_tokens: 7, output_tokens: 3 },
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

async function loadWorker(code: string): Promise<{
  fetch: (req: Request, env: Record<string, string>) => Promise<Response>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "cfw-wf-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(file, code);
  const mod = (await import(file)).default;
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

async function driveChat(code: string): Promise<SseEvent[]> {
  const worker = await loadWorker(code);
  const req = new Request("https://harness.example/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://studio.crewhaus.ai" },
    body: JSON.stringify({ messages: [{ role: "user", content: "go" }] }),
  });
  const res = await worker.fetch(req, { ANTHROPIC_API_KEY: "sk-test" });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no response body");
  const dec = new TextDecoder();
  let buffer = "";
  const out: SseEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let name = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) name = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) out.push({ name, data: JSON.parse(data) as Record<string, unknown> });
      sep = buffer.indexOf("\n\n");
    }
  }
  return out;
}

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

describe("emitCfWorkerWorkflow — trace SSE frames (Batch C, item 3)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    installAnthropicStub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const workerCode = (ir: IrWorkflowV0) =>
    emitCfWorkerWorkflow(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

  test("brackets every step with step_start/step_end + per-step usage/cost, then a done", async () => {
    const events = await driveChat(workerCode(baseIr)); // baseIr has 3 steps
    const done = events.find((e) => e.name === "done");
    expect(done?.data).toEqual({ text: "Final.", stopReason: "end_turn" });

    const traces = events.filter((e) => e.name === "trace");
    const byKind = (k: string) => traces.filter((e) => e.data["kind"] === k);
    expect(byKind("step_start")).toHaveLength(3);
    expect(byKind("step_end")).toHaveLength(3);
    expect(byKind("model_response")).toHaveLength(3);
    expect(byKind("cost_accrual")).toHaveLength(3);

    // step_start carries the step name + 1-based index / total.
    expect(byKind("step_start")[0]?.data).toMatchObject({
      kind: "step_start",
      name: "research",
      step: 1,
      total: 3,
    });

    // Intermediate steps report the non-streaming usage (7 in / 3 out); the
    // final streaming step reports the streamed usage (10 in / 5 out).
    const responses = byKind("model_response");
    expect(responses[0]?.data).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      usage: { input: 7, output: 3 },
    });
    expect(responses[2]?.data).toMatchObject({ usage: { input: 10, output: 5 } });

    // cost_accrual is unpriced (the inlined worker carries no pricing table).
    expect(byKind("cost_accrual")[0]?.data).toMatchObject({
      kind: "cost_accrual",
      provider: "anthropic",
      inputTokens: 7,
      outputTokens: 3,
      costUsdMicros: 0,
      unpriced: true,
    });
  });

  test("the final step's step_start precedes its step_end which precedes done", async () => {
    const events = await driveChat(workerCode(baseIr));
    const kindsInOrder = events
      .filter((e) => e.name === "trace" || e.name === "done")
      .map((e) => (e.name === "done" ? "done" : (e.data["kind"] as string)));
    // Last three meaningful markers: model_response, step_end (step 3), done.
    expect(kindsInOrder[kindsInOrder.length - 1]).toBe("done");
    expect(kindsInOrder[kindsInOrder.length - 2]).toBe("step_end");
  });

  // IrWorkflowV0 does not yet carry `observability`; the emitter reads it
  // structurally (forward-compatible gate). Cast the fixtures to attach it.
  const withObs = (level: string): IrWorkflowV0 =>
    ({ ...baseIr, observability: { trace: { level } } }) as unknown as IrWorkflowV0;

  test("observability.trace: off emits NO trace frames (text/done still flow)", async () => {
    const code = workerCode(withObs("off"));
    expect(code).toContain("trace: false");
    const events = await driveChat(code);
    expect(events.some((e) => e.name === "trace")).toBe(false);
    expect(events.find((e) => e.name === "done")?.data).toEqual({
      text: "Final.",
      stopReason: "end_turn",
    });
  });

  test("trace bakes ON by default and for a non-off level", () => {
    expect(workerCode(baseIr)).toContain("trace: true");
    expect(workerCode(withObs("json"))).toContain("trace: true");
  });
});
