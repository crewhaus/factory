import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrGraphNode, IrGraphV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerGraph } from "./index";

/**
 * SSE-frame test harness (Batch C, item 3). Executes the emitted worker
 * in-process against a stubbed Anthropic endpoint (streaming for the final
 * node, non-streaming JSON for intermediate nodes) and collects the SSE frames
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

/** Stub Anthropic: JSON for `stream:false` intermediate nodes, SSE for the final. */
function installAnthropicStub(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { stream?: boolean };
    if (body.stream) {
      return new Response(
        anthropicStreamBody({ input: 10, output: 5, text: "Summary.", stopReason: "end_turn" }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "node output" }],
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
  const dir = mkdtempSync(join(tmpdir(), "cfw-graph-"));
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

const node = (name: string, instructions: string): IrGraphNode => ({
  name,
  instructions,
  model: "claude-haiku-4-5-20251001",
  tools: [],
  toolConfigs: Object.freeze({}),
});

// entry -> execute -> summarise : a single linear path.
const baseIr: IrGraphV0 = {
  version: 0,
  name: "hello-graph",
  target: "graph",
  entry: "plan",
  nodes: [
    node("plan", "Plan the work."),
    node("execute", "Execute the plan."),
    node("summarise", "Summarise the result."),
  ],
  edges: [
    { from: "plan", to: "execute" },
    { from: "execute", to: "summarise" },
  ],
  permissions: { rules: [] },
  compaction: {},
};

const parseJs = (code: string) => new Bun.Transpiler({ loader: "js" }).transformSync(code);

describe("emitCfWorkerGraph", () => {
  test("emits worker.js, wrangler.toml, package.json, and the generated README (item 42)", () => {
    const bundle = emitCfWorkerGraph(baseIr);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "package.json", "worker.js", "wrangler.toml"]);
    const readme = bundle.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("wrangler deploy");
  });

  test("readme: false restores the three-file bundle (item 42 opt-out)", () => {
    const bundle = emitCfWorkerGraph(baseIr, { readme: false });
    expect(bundle.files.map((f) => f.path).sort()).toEqual([
      "package.json",
      "worker.js",
      "wrangler.toml",
    ]);
  });

  test("worker.js inlines every node's model + instructions and the Anthropic endpoint", () => {
    const bundle = emitCfWorkerGraph(baseIr);
    const worker = bundle.files.find((f) => f.path === "worker.js")?.content ?? "";
    expect(worker).toContain("claude-haiku-4-5-20251001");
    expect(worker).toContain("Plan the work.");
    expect(worker).toContain("Execute the plan.");
    expect(worker).toContain("Summarise the result.");
    expect(worker).toContain("api.anthropic.com");
    // Speaks the same /chat SSE protocol the PWA expects.
    expect(worker).toContain("/chat");
    expect(worker).toContain("/health");
    expect(worker).toContain('"done"');
  });

  test("nodes are baked in linear execution order, not declaration order", () => {
    // Declared out of order; edges still form plan -> execute -> summarise.
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("summarise", "S"), node("plan", "P"), node("execute", "E")],
    };
    const worker = emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";
    const iPlan = worker.indexOf('name: "plan"');
    const iExec = worker.indexOf('name: "execute"');
    const iSumm = worker.indexOf('name: "summarise"');
    expect(iPlan).toBeGreaterThanOrEqual(0);
    expect(iPlan).toBeLessThan(iExec);
    expect(iExec).toBeLessThan(iSumm);
  });

  test("wrangler.toml uses sanitized spec name", () => {
    const ir: IrGraphV0 = { ...baseIr, name: "Hello World!" };
    const wrangler =
      emitCfWorkerGraph(ir).files.find((f) => f.path === "wrangler.toml")?.content ?? "";
    expect(wrangler).toContain('name = "hello-world-"');
  });

  test("worker.js escapes special characters in instructions", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [
        { ...node("plan", 'Respond with "quoted" text\nand newlines.') },
        node("execute", "ok"),
      ],
      edges: [{ from: "plan", to: "execute" }],
    };
    const worker = emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";
    expect(worker).toContain('\\"quoted\\"');
    expect(worker).toContain("\\n");
  });

  test("rejects non-graph IR variants", () => {
    const wrong = { ...baseIr, target: "cli" } as unknown as IrGraphV0;
    expect(() => emitCfWorkerGraph(wrong)).toThrow(TargetEmitError);
  });

  test("rejects a branching graph (node with 2 outgoing edges)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [
        { from: "plan", to: "execute" },
        { from: "plan", to: "summarise" },
      ],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/linear single-path/);
  });

  test("rejects a node with hitlPrompt set", () => {
    const planNode = baseIr.nodes[0];
    if (planNode === undefined) throw new Error("baseIr is missing the plan node");
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [{ ...planNode, hitlPrompt: "approve?" }, node("execute", "E")],
      edges: [{ from: "plan", to: "execute" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/HITL/);
  });

  test("rejects nodes that declare tools", () => {
    const planNode = baseIr.nodes[0];
    if (planNode === undefined) throw new Error("baseIr is missing the plan node");
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [{ ...planNode, tools: ["read", "write"] }, node("execute", "E")],
      edges: [{ from: "plan", to: "execute" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/tools/);
  });

  test("rejects an entry that doesn't reference a declared node", () => {
    const ir: IrGraphV0 = { ...baseIr, entry: "missing" };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/entry node "missing"/);
  });

  test("rejects an edge that references an unknown from-node", () => {
    const ir: IrGraphV0 = { ...baseIr, edges: [{ from: "ghost", to: "plan" }] };
    expect(() => emitCfWorkerGraph(ir)).toThrow(/unknown node "ghost"/);
  });

  test("rejects an edge that references an unknown to-node", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P")],
      edges: [{ from: "plan", to: "ghost" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(/unknown node "ghost"/);
  });

  test("rejects unreachable nodes (node not on the path from entry)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P"), node("execute", "E"), node("orphan", "O")],
      edges: [{ from: "plan", to: "execute" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/unreachable nodes: orphan/);
  });

  test("rejects a cycle", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P"), node("execute", "E")],
      edges: [
        { from: "plan", to: "execute" },
        { from: "execute", to: "plan" },
      ],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/cycle detected/);
  });

  test("accepts a single-node graph with no edges", () => {
    const ir: IrGraphV0 = { ...baseIr, nodes: [node("plan", "P")], edges: [] };
    const worker = emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";
    expect(worker).toContain('name: "plan"');
    expect(() => parseJs(worker)).not.toThrow();
  });

  // Regression guard: the emitter must never wrap escapeJsonString output in
  // extra quotes (`name: ""hello-graph""`), which Cloudflare rejects at upload
  // with a syntax error. Substring assertions miss it, so parse the whole
  // module instead.
  test("worker.js is syntactically valid JavaScript", () => {
    const worker = emitCfWorkerGraph(baseIr).files.find((f) => f.path === "worker.js")?.content;
    expect(() => parseJs(worker ?? "")).not.toThrow();
  });

  test("worker.js stays valid with tricky node instructions (quotes/newline/$/backtick)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      name: "tricky-graph",
      nodes: [
        node("plan", 'Quotes "here", a newline\nhere, a ${dollar} and a ` backtick.'),
        node("execute", "Plain second node."),
      ],
      edges: [{ from: "plan", to: "execute" }],
    };
    const worker = emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content;
    expect(() => parseJs(worker ?? "")).not.toThrow();
  });
});

describe("emitCfWorkerGraph — package.json name injection (#148)", () => {
  test("package.json sanitizes the spec name and resists JSON injection", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      name: '", "dependencies": { "evil-typosquat": "1.0.0" }, "x": "',
    };
    const pkg = emitCfWorkerGraph(ir).files.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    const parsed = JSON.parse(pkg?.content ?? "") as {
      name: string;
      dependencies?: Record<string, string>;
    };
    expect(parsed.name).not.toContain('"'); // sanitized to [a-z0-9-]
    expect(parsed.dependencies).toBeUndefined(); // injection did not break out
  });
});

describe("emitCfWorkerGraph — provider gate", () => {
  test("a graph with one openai/ node fails at compile time, naming the node", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [
        node("plan", "Plan the work."),
        { ...node("execute", "Execute the plan."), model: "openai/gpt-4o-mini" },
        node("summarise", "Summarise the result."),
      ],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(
      /cf-worker targets currently support claude-\* models only — use the cli target for other providers/,
    );
    expect(() => emitCfWorkerGraph(ir)).toThrow(/node "execute"/);
  });

  test("gemini/, bedrock/, and local/ node models are all rejected", () => {
    for (const model of [
      "gemini/gemini-2.5-flash",
      "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "local/llama3.2@http://localhost:11434/v1",
    ]) {
      const ir: IrGraphV0 = {
        ...baseIr,
        nodes: [{ ...node("plan", "P"), model }],
        edges: [],
        entry: "plan",
      };
      expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    }
  });

  test("all-claude nodes still emit cleanly", () => {
    expect(emitCfWorkerGraph(baseIr).files.length).toBe(4);
  });
});

describe("emitCfWorkerGraph — failure_taxonomy ignored-note (item 23)", () => {
  test("worker.js carries the ignored-taxonomy note when the spec declares one", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    };
    const code = emitCfWorkerGraph(ir).files[0]?.content ?? "";
    expect(code).toContain(
      "failure_taxonomy configured but target-cf-worker-graph does not yet wire it up",
    );
  });

  test("no note when the spec omits failure_taxonomy", () => {
    expect(emitCfWorkerGraph(baseIr).files[0]?.content ?? "").not.toContain(
      "failure_taxonomy configured",
    );
  });
});

describe("emitCfWorkerGraph — trace SSE frames (Batch C, item 3)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    installAnthropicStub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const workerCode = (ir: IrGraphV0) =>
    emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

  test("brackets every node with node_start/node_end + per-node usage/cost, then a done", async () => {
    const events = await driveChat(workerCode(baseIr)); // 3 nodes: plan → execute → summarise
    const done = events.find((e) => e.name === "done");
    expect(done?.data).toEqual({ text: "Summary.", stopReason: "end_turn" });

    const traces = events.filter((e) => e.name === "trace");
    const byKind = (k: string) => traces.filter((e) => e.data["kind"] === k);
    expect(byKind("node_start")).toHaveLength(3);
    expect(byKind("node_end")).toHaveLength(3);
    expect(byKind("model_response")).toHaveLength(3);
    expect(byKind("cost_accrual")).toHaveLength(3);

    // node_start carries the node name + 1-based index / total.
    expect(byKind("node_start")[0]?.data).toMatchObject({
      kind: "node_start",
      name: "plan",
      node: 1,
      total: 3,
    });

    // Intermediate nodes report the non-streaming usage (7 in / 3 out); the
    // final streaming node reports the streamed usage (10 in / 5 out).
    const responses = byKind("model_response");
    expect(responses[0]?.data).toMatchObject({ usage: { input: 7, output: 3 } });
    expect(responses[2]?.data).toMatchObject({ usage: { input: 10, output: 5 } });

    expect(byKind("cost_accrual")[2]?.data).toMatchObject({
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
      inputTokens: 10,
      outputTokens: 5,
      costUsdMicros: 0,
      unpriced: true,
    });
  });

  test("the final node's node_end precedes done", async () => {
    const events = await driveChat(workerCode(baseIr));
    const kindsInOrder = events
      .filter((e) => e.name === "trace" || e.name === "done")
      .map((e) => (e.name === "done" ? "done" : (e.data["kind"] as string)));
    expect(kindsInOrder[kindsInOrder.length - 1]).toBe("done");
    expect(kindsInOrder[kindsInOrder.length - 2]).toBe("node_end");
  });

  // IrGraphV0 does not yet carry `observability`; the emitter reads it
  // structurally (forward-compatible gate). Cast the fixtures to attach it.
  const withObs = (level: string): IrGraphV0 =>
    ({ ...baseIr, observability: { trace: { level } } }) as unknown as IrGraphV0;

  test("observability.trace: off emits NO trace frames (text/done still flow)", async () => {
    const code = workerCode(withObs("off"));
    expect(code).toContain("trace: false");
    const events = await driveChat(code);
    expect(events.some((e) => e.name === "trace")).toBe(false);
    expect(events.find((e) => e.name === "done")?.data).toEqual({
      text: "Summary.",
      stopReason: "end_turn",
    });
  });

  test("trace bakes ON by default and for a non-off level", () => {
    expect(workerCode(baseIr)).toContain("trace: true");
    expect(workerCode(withObs("ring"))).toContain("trace: true");
  });
});
