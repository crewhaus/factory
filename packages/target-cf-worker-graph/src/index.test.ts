import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IrGraphNode, IrGraphV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerGraph, resolveGraphTools } from "./index";

/**
 * Loop contract 0.4 (Batch F, G12/G83) — each graph node now runs the SHARED
 * `@crewhaus/worker-runtime` loop instead of a bespoke inlined client. These
 * tests pin the generated wiring, keep the linear/HITL structural gates, BUILD
 * the emitted worker (transpiles; tools-free stays node-free — the payoff of
 * G12), and EXECUTE it against a stubbed Anthropic transport in a `bun`
 * SUBPROCESS (see the CLI emitter's test for why the drive runs out-of-process).
 */

const SRC_DIR = import.meta.dir;

const workerCode = (ir: IrGraphV0): string =>
  emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

const node = (
  name: string,
  instructions: string,
  over: Partial<IrGraphNode> = {},
): IrGraphNode => ({
  name,
  instructions,
  model: "claude-haiku-4-5-20251001",
  tools: [],
  toolConfigs: Object.freeze({}),
  ...over,
});

// plan -> execute -> summarise : a single linear path.
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

// --- subprocess harness (see target-cf-worker-cli's index.test.ts) -----------

const DRIVER_SRC = String.raw`
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const job = JSON.parse(await Bun.file(here + "job.json").text());
const workerPath = here + "worker.mjs";
const result = {};
try {
  if (job.mode === "build") {
    const b = await Bun.build({ entrypoints: [workerPath], target: job.buildTarget });
    result.success = b.success;
    if (b.success) {
      const t = (await Promise.all(b.outputs.map((o) => o.text()))).join("\n");
      result.nodeFree = !/["']node:/.test(t);
      result.bytes = t.length;
      if (job.expectContains) result.contains = t.includes(job.expectContains);
    } else {
      result.logs = b.logs.map(String);
    }
  } else {
    let calls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("api.anthropic.com")) {
        const turn = job.turns[calls] ?? [];
        calls += 1;
        const enc = new TextEncoder();
        const body = new ReadableStream({
          start(c) {
            for (const o of turn) c.enqueue(enc.encode("event: " + o.type + "\ndata: " + JSON.stringify(o) + "\n\n"));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("unexpected", { status: 500 });
    };
    const worker = (await import(workerPath)).default;
    const req = new Request("https://harness.example/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.crewhaus.ai" },
      body: JSON.stringify(job.body ?? { messages: [{ role: "user", content: "go" }] }),
    });
    const res = await worker.fetch(req, { ANTHROPIC_API_KEY: "sk-test" });
    result.status = res.status;
    result.raw = await res.text();
    result.calls = calls;
  }
} catch (e) {
  result.error = e && e.message ? e.message : String(e);
}
process.stdout.write(JSON.stringify(result));
`;

type JobResult = {
  success?: boolean;
  nodeFree?: boolean;
  contains?: boolean;
  logs?: string[];
  status?: number;
  raw?: string;
  calls?: number;
  error?: string;
};

async function runJob(code: string, job: Record<string, unknown>): Promise<JobResult> {
  const dir = mkdtempSync(join(SRC_DIR, ".cfw-run-"));
  writeFileSync(join(dir, "worker.mjs"), code);
  writeFileSync(join(dir, "job.json"), JSON.stringify(job));
  writeFileSync(join(dir, "driver.mjs"), DRIVER_SRC);
  try {
    const proc = Bun.spawn([process.execPath, join(dir, "driver.mjs")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (!out) throw new Error(`driver produced no output; stderr:\n${err}`);
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Frame = Record<string, unknown>;
function textTurn(
  text: string,
  opts: { input?: number; output?: number; stopReason?: string } = {},
): Frame[] {
  return [
    {
      type: "message_start",
      message: { usage: { input_tokens: opts.input ?? 10, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: opts.stopReason ?? "end_turn" },
      usage: { output_tokens: opts.output ?? 5 },
    },
    { type: "message_stop" },
  ];
}
function toolTurn(id: string, name: string, input: Record<string, unknown>): Frame[] {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}
type SseEvent = { name: string; data: Record<string, unknown> };
function parseSse(raw: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let name = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) out.push({ name, data: JSON.parse(data) as Record<string, unknown> });
  }
  return out;
}

const parseJs = (code: string) => new Bun.Transpiler({ loader: "js" }).transformSync(code);

// --- bundle shape ------------------------------------------------------------

describe("emitCfWorkerGraph — bundle shape", () => {
  test("emits worker.js, wrangler.toml, package.json, and the generated README (item 42)", () => {
    expect(
      emitCfWorkerGraph(baseIr)
        .files.map((f) => f.path)
        .sort(),
    ).toEqual(["README.md", "package.json", "worker.js", "wrangler.toml"]);
    expect(
      emitCfWorkerGraph(baseIr).files.find((f) => f.path === "README.md")?.content ?? "",
    ).toContain("wrangler deploy");
  });

  test("readme: false restores the three-file bundle (item 42 opt-out)", () => {
    expect(
      emitCfWorkerGraph(baseIr, { readme: false })
        .files.map((f) => f.path)
        .sort(),
    ).toEqual(["package.json", "worker.js", "wrangler.toml"]);
  });

  test("worker.js runs the shared runtime and bakes every node's model + instructions", () => {
    const worker = workerCode(baseIr);
    expect(worker).toContain('from "@crewhaus/worker-runtime"');
    expect(worker).toContain("runWorkerLoop");
    expect(worker).not.toContain("api.anthropic.com"); // moved into the shared adapter
    expect(worker).toContain("Plan the work.");
    expect(worker).toContain("Execute the plan.");
    expect(worker).toContain("Summarise the result.");
    expect(worker).toContain("/chat");
    expect(worker).toContain("/health");
    expect(worker).toContain('"done"');
  });

  test("nodes are baked in linear execution order, not declaration order", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("summarise", "Summarise."), node("plan", "Plan."), node("execute", "Execute.")],
    };
    const worker = workerCode(ir);
    const planIdx = worker.indexOf("Plan.");
    const execIdx = worker.indexOf("Execute.");
    const sumIdx = worker.indexOf("Summarise.");
    expect(planIdx).toBeLessThan(execIdx);
    expect(execIdx).toBeLessThan(sumIdx);
  });

  test("wrangler.toml uses sanitized spec name + keeps nodejs_compat", () => {
    const wrangler =
      emitCfWorkerGraph({ ...baseIr, name: "Hello Graph!" }).files.find(
        (f) => f.path === "wrangler.toml",
      )?.content ?? "";
    expect(wrangler).toContain('name = "hello-graph-"');
    expect(wrangler).toContain('compatibility_flags = ["nodejs_compat"]');
  });

  test("worker.js escapes special characters in instructions", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "only",
      nodes: [node("only", 'Respond with "quoted" text\nand newlines.')],
      edges: [],
    };
    const worker = workerCode(ir);
    expect(worker).toContain('\\"quoted\\"');
    expect(worker).toContain("\\n");
  });

  test("per-node max_tokens / thinking bake into CONFIG.nodes", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "only",
      nodes: [node("only", "i", { maxTokens: 1024, thinking: { effort: "low" } })],
      edges: [],
    };
    const worker = workerCode(ir);
    expect(worker).toContain("maxTokens: 1024");
    expect(worker).toContain('thinking: {"effort":"low"}');
  });

  test("worker.js is syntactically valid ES module", () => {
    expect(() => parseJs(workerCode(baseIr))).not.toThrow();
  });

  test("worker.js stays valid with tricky node instructions", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "tricky",
      nodes: [node("tricky", 'Quotes "here", a newline\nhere, a ${dollar} and a ` backtick.')],
      edges: [],
    };
    expect(() => parseJs(workerCode(ir))).not.toThrow();
  });
});

// --- structural gates (linear / HITL) ----------------------------------------

describe("emitCfWorkerGraph — structural gates", () => {
  test("rejects non-graph IR variants", () => {
    expect(() => emitCfWorkerGraph({ ...baseIr, target: "cli" } as unknown as IrGraphV0)).toThrow(
      TargetEmitError,
    );
  });

  test("rejects a branching graph (node with 2 outgoing edges)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P"), node("execute", "E"), node("summarise", "S")],
      edges: [
        { from: "plan", to: "execute" },
        { from: "plan", to: "summarise" },
      ],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(/linear single-path/);
  });

  test("rejects a node with hitlPrompt set", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P", { hitlPrompt: "approve?" }), node("execute", "E")],
      edges: [{ from: "plan", to: "execute" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(/HITL/);
  });

  test("rejects an entry that doesn't reference a declared node", () => {
    expect(() => emitCfWorkerGraph({ ...baseIr, entry: "missing" })).toThrow(
      /entry node "missing"/,
    );
  });

  test("rejects an edge that references an unknown node", () => {
    const ir: IrGraphV0 = { ...baseIr, edges: [{ from: "plan", to: "ghost" }] };
    expect(() => emitCfWorkerGraph(ir)).toThrow(/unknown node "ghost"/);
  });

  test("rejects unreachable nodes", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P"), node("execute", "E"), node("orphan", "O")],
      edges: [{ from: "plan", to: "execute" }],
    };
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
    expect(() => emitCfWorkerGraph(ir)).toThrow(/cycle detected/);
  });

  test("accepts a single-node graph with no edges", () => {
    const ir: IrGraphV0 = { ...baseIr, entry: "only", nodes: [node("only", "Solo.")], edges: [] };
    expect(() => parseJs(workerCode(ir))).not.toThrow();
  });
});

// --- edge-safe tool gate -----------------------------------------------------

describe("resolveGraphTools — the cf-worker tool gate (G12/G83)", () => {
  test("host tools in any node throw a clear compile error", () => {
    expect(() =>
      resolveGraphTools([node("a", "A", { tools: ["read", "write"] }), node("b", "B")]),
    ).toThrow(/cf-worker target cannot run 2 host tool\(s\)/);
  });

  test("emitCfWorkerGraph rejects host tools too", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "only",
      nodes: [node("only", "i", { tools: ["bash"] })],
      edges: [],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(/cf-worker target cannot run 1 host tool/);
  });

  test("edge-safe tools wire per node; imports dedupe across nodes", () => {
    const wiring = resolveGraphTools([
      node("a", "A", { tools: ["webSearch", "todoWrite"] }),
      node("b", "B", { tools: ["webSearch"] }),
    ]);
    expect(wiring.nodeTools).toEqual(["[__t_webSearch, __t_todoWrite]", "[__t_webSearch]"]);
    expect(wiring.imports.match(/webSearch as __t_webSearch/g)?.length).toBe(1);
    expect(wiring.packages).toContain("@crewhaus/tool-web");
  });

  test("mcp__* and custom tools are permitted but unwired + noted", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "only",
      nodes: [node("only", "i", { tools: ["mcp__s__t", "myThing"] })],
      edges: [],
    };
    const worker = workerCode(ir);
    expect(worker).toContain("permitted but not wired");
    expect(worker).toContain("mcp__s__t");
  });
});

// --- package.json + provider gate + taxonomy ---------------------------------

describe("emitCfWorkerGraph — package.json + gates", () => {
  test("package.json sanitizes the spec name and resists JSON injection (#148)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      name: '", "dependencies": { "evil-typosquat": "1.0.0" }, "x": "',
    };
    const parsed = JSON.parse(
      emitCfWorkerGraph(ir).files.find((f) => f.path === "package.json")?.content ?? "",
    ) as { name: string; dependencies: Record<string, string> };
    expect(parsed.name).not.toContain('"');
    expect(parsed.dependencies["evil-typosquat"]).toBeUndefined();
    expect(parsed.dependencies["@crewhaus/worker-runtime"]).toBeDefined();
  });

  test("edge-safe tool packages are declared in package.json", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "only",
      nodes: [node("only", "i", { tools: ["todoWrite"] })],
      edges: [],
    };
    const deps = (
      JSON.parse(
        emitCfWorkerGraph(ir).files.find((f) => f.path === "package.json")?.content ?? "",
      ) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    expect(deps["@crewhaus/tool-todo"]).toBeDefined();
  });

  test("a graph with one openai/ node fails at compile time, naming the node", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [
        node("plan", "P"),
        node("execute", "E", { model: "openai/gpt-4o-mini" }),
        node("summarise", "S"),
      ],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(
      /cf-worker targets currently support claude-\* models only/,
    );
    expect(() => emitCfWorkerGraph(ir)).toThrow(/node "execute"/);
  });

  test("all-claude nodes still emit cleanly", () => {
    expect(emitCfWorkerGraph(baseIr).files.length).toBe(4);
  });

  test("failure_taxonomy ignored-note appears only when declared", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    };
    expect(workerCode(ir)).toContain(
      "failure_taxonomy configured but target-cf-worker-graph does not wire it up",
    );
    expect(workerCode(baseIr)).not.toContain("failure_taxonomy configured");
  });
});

// --- the emitted worker builds -----------------------------------------------

describe("emitCfWorkerGraph — the emitted worker builds", () => {
  test("a tools-free graph bundles for the edge with ZERO node: specifiers", async () => {
    const r = await runJob(workerCode(baseIr), { mode: "build", buildTarget: "browser" });
    expect(r.error).toBeUndefined();
    expect(r.success, JSON.stringify(r.logs)).toBe(true);
    expect(r.nodeFree).toBe(true);
  });

  test("a graph with an edge-safe tool transpiles with the tool wired in", async () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "only",
      nodes: [node("only", "i", { tools: ["todoWrite"] })],
      edges: [],
    };
    const r = await runJob(workerCode(ir), {
      mode: "build",
      buildTarget: "node",
      expectContains: "TodoWrite",
    });
    expect(r.error).toBeUndefined();
    expect(r.success, JSON.stringify(r.logs)).toBe(true);
    expect(r.contains).toBe(true);
  });
});

// --- SSE frames through the shared runtime -----------------------------------

describe("emitCfWorkerGraph — /chat SSE through the shared runtime", () => {
  test("brackets every node with node_start/node_end + per-node usage/cost, then done", async () => {
    const r = await runJob(workerCode(baseIr), {
      mode: "drive",
      turns: [
        textTurn("plan out", { input: 7, output: 3 }),
        textTurn("exec out", { input: 7, output: 3 }),
        textTurn("Final.", { input: 10, output: 5 }),
      ],
    });
    expect(r.error).toBeUndefined();
    expect(r.calls).toBe(3);
    const events = parseSse(r.raw ?? "");

    expect(events.find((e) => e.name === "done")?.data).toEqual({
      text: "Final.",
      stopReason: "end_turn",
    });

    const byKind = (k: string) => events.filter((e) => e.name === "trace" && e.data["kind"] === k);
    expect(byKind("node_start")).toHaveLength(3);
    expect(byKind("node_end")).toHaveLength(3);
    expect(byKind("model_response")).toHaveLength(3);
    expect(byKind("cost_accrual")).toHaveLength(3);

    expect(byKind("node_start")[0]?.data).toMatchObject({
      kind: "node_start",
      name: "plan",
      node: 1,
      total: 3,
    });
    expect(byKind("model_response")[2]?.data).toMatchObject({ usage: { input: 10, output: 5 } });
    expect(byKind("cost_accrual")[0]?.data).toMatchObject({
      kind: "cost_accrual",
      provider: "anthropic",
      inputTokens: 7,
      outputTokens: 3,
      unpriced: true,
    });
  });

  test("only the last node streams text; upstream node output threads into state", async () => {
    const r = await runJob(workerCode(baseIr), {
      mode: "drive",
      turns: [textTurn("plan out"), textTurn("exec out"), textTurn("Final answer.")],
    });
    const streamed = parseSse(r.raw ?? "")
      .filter((e) => e.name === "text")
      .map((e) => e.data["text"])
      .join("");
    expect(streamed).toContain("Final answer.");
    expect(streamed).not.toContain("plan out");
    expect(streamed).not.toContain("exec out");
  });

  test("a node runs a REAL tool round-trip through the loop", async () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "only",
      nodes: [node("only", "i", { tools: ["todoWrite"] })],
      edges: [],
    };
    const r = await runJob(workerCode(ir), {
      mode: "drive",
      turns: [
        toolTurn("t1", "TodoWrite", {
          todos: [{ id: "1", content: "go", status: "pending", priority: "high" }],
        }),
        textTurn("node done"),
      ],
    });
    expect(r.error).toBeUndefined();
    expect(r.calls).toBe(2);
    const kinds = parseSse(r.raw ?? "")
      .filter((e) => e.name === "trace")
      .map((e) => e.data["kind"]);
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_end");
  });

  test("the final node's node_end precedes done", async () => {
    const r = await runJob(workerCode(baseIr), {
      mode: "drive",
      turns: [textTurn("a"), textTurn("b"), textTurn("c")],
    });
    const markers = parseSse(r.raw ?? "")
      .filter((e) => e.name === "trace" || e.name === "done")
      .map((e) => (e.name === "done" ? "done" : (e.data["kind"] as string)));
    expect(markers[markers.length - 1]).toBe("done");
    expect(markers[markers.length - 2]).toBe("node_end");
  });

  test("a node that overflows ends the run with a classified error frame", async () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: "only",
      nodes: [node("only", "i")],
      edges: [],
      limits: { contextLimit: 1 },
    };
    const r = await runJob(workerCode(ir), { mode: "drive", turns: [textTurn("never")] });
    const events = parseSse(r.raw ?? "");
    expect(events.some((e) => e.name === "done")).toBe(false);
    const err = events.find((e) => e.name === "error");
    expect(String(err?.data["message"])).toMatch(/context window exceeded/i);
  });

  const withObs = (level: string): IrGraphV0 =>
    ({ ...baseIr, observability: { trace: { level } } }) as unknown as IrGraphV0;

  test("observability.trace: off emits NO trace frames (text/done still flow)", async () => {
    const code = workerCode(withObs("off"));
    expect(code).toContain("trace: false");
    const r = await runJob(code, {
      mode: "drive",
      turns: [textTurn("a"), textTurn("b"), textTurn("Final.")],
    });
    const events = parseSse(r.raw ?? "");
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
