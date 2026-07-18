import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IrWorkflowStep, IrWorkflowV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerWorkflow, resolveWorkflowTools } from "./index";

/**
 * Loop contract 0.4 (Batch F, G12/G83) — each workflow step now runs the SHARED
 * `@crewhaus/worker-runtime` loop instead of a bespoke inlined client. These
 * tests pin the generated wiring, BUILD the emitted worker (transpiles; and,
 * tools-free, stays node-free — the payoff of G12), and EXECUTE it against a
 * stubbed Anthropic transport in a `bun` SUBPROCESS (see the CLI emitter's test
 * for why the drive runs out-of-process).
 */

const SRC_DIR = import.meta.dir;

const workerCode = (ir: IrWorkflowV0): string =>
  emitCfWorkerWorkflow(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

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
    step({ name: "draft", instructions: "Draft a summary.", model: "claude-sonnet-4-5-20250929" }),
    step({ name: "polish", instructions: "Polish the draft.", model: "claude-opus-4-5-20250101" }),
  ],
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

// --- subprocess harness (see index.test.ts of target-cf-worker-cli) ----------

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

// --- bundle shape ------------------------------------------------------------

describe("emitCfWorkerWorkflow — bundle shape", () => {
  test("emits worker.js, wrangler.toml, package.json, and the generated README (item 42)", () => {
    const bundle = emitCfWorkerWorkflow(baseIr);
    expect(bundle.files.map((f) => f.path).sort()).toEqual([
      "README.md",
      "package.json",
      "worker.js",
      "wrangler.toml",
    ]);
    expect(bundle.files.find((f) => f.path === "README.md")?.content ?? "").toContain(
      "wrangler deploy",
    );
  });

  test("readme: false restores the three-file bundle (item 42 opt-out)", () => {
    expect(
      emitCfWorkerWorkflow(baseIr, { readme: false })
        .files.map((f) => f.path)
        .sort(),
    ).toEqual(["package.json", "worker.js", "wrangler.toml"]);
  });

  test("worker.js runs the shared runtime and bakes each step's model + instructions", () => {
    const worker = workerCode(baseIr);
    expect(worker).toContain('from "@crewhaus/worker-runtime"');
    expect(worker).toContain("runWorkerLoop");
    expect(worker).not.toContain("api.anthropic.com"); // moved into the shared adapter
    for (const s of baseIr.steps) {
      expect(worker).toContain(s.model);
      expect(worker).toContain(s.instructions);
      expect(worker).toContain(s.name);
    }
  });

  test("worker.js threads the prior step's output into later steps", () => {
    const worker = workerCode(baseIr);
    expect(worker).toContain("## Output of previous step:");
    expect(worker).toContain("begin"); // empty user input fallback
  });

  test("wrangler.toml uses sanitized spec name + keeps nodejs_compat", () => {
    const wrangler =
      emitCfWorkerWorkflow({ ...baseIr, name: "Summarize Flow!" }).files.find(
        (f) => f.path === "wrangler.toml",
      )?.content ?? "";
    expect(wrangler).toContain('name = "summarize-flow-"');
    expect(wrangler).toContain('compatibility_flags = ["nodejs_compat"]');
  });

  test("worker.js escapes special characters in instructions", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      steps: [step({ instructions: 'Respond with "quoted" text\nand newlines.' })],
    };
    const worker = workerCode(ir);
    expect(worker).toContain('\\"quoted\\"');
    expect(worker).toContain("\\n");
  });

  test("per-step max_tokens / thinking bake into CONFIG.steps", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      steps: [step({ maxTokens: 2048, thinking: { budgetTokens: 1024 } })],
    };
    const worker = workerCode(ir);
    expect(worker).toContain("maxTokens: 2048");
    expect(worker).toContain('thinking: {"budgetTokens":1024}');
  });

  test("rejects non-workflow IR variants", () => {
    const wrong = { ...baseIr, target: "cli" } as unknown as IrWorkflowV0;
    expect(() => emitCfWorkerWorkflow(wrong)).toThrow(TargetEmitError);
  });

  const parseJs = (code: string) => new Bun.Transpiler({ loader: "js" }).transformSync(code);

  test("worker.js is syntactically valid ES module", () => {
    expect(() => parseJs(workerCode(baseIr))).not.toThrow();
  });

  test("worker.js stays valid with hyphenated name and tricky instructions", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      steps: [
        step({
          name: "tricky-step",
          instructions: 'Quotes "here", a newline\nhere, a ${dollar} and a ` backtick.',
        }),
        step({ name: "second-step", instructions: "Plain second step." }),
      ],
    };
    expect(() => parseJs(workerCode(ir))).not.toThrow();
  });
});

// --- edge-safe tool gate -----------------------------------------------------

describe("resolveWorkflowTools — the cf-worker tool gate (G12/G83)", () => {
  test("host tools in any step throw a clear compile error", () => {
    expect(() =>
      resolveWorkflowTools([step({ tools: [] }), step({ name: "b", tools: ["read", "write"] })]),
    ).toThrow(/cf-worker target cannot run 2 host tool\(s\)/);
  });

  test("emitCfWorkerWorkflow rejects host tools too", () => {
    const ir: IrWorkflowV0 = { ...baseIr, steps: [step({ tools: ["bash"] })] };
    expect(() => emitCfWorkerWorkflow(ir)).toThrow(/cf-worker target cannot run 1 host tool/);
  });

  test("edge-safe tools wire per step; imports dedupe across steps", () => {
    const wiring = resolveWorkflowTools([
      step({ name: "a", tools: ["webSearch", "todoWrite"] }),
      step({ name: "b", tools: ["webSearch"] }),
    ]);
    expect(wiring.stepTools).toEqual(["[__t_webSearch, __t_todoWrite]", "[__t_webSearch]"]);
    // webSearch imported once even though two steps use it.
    expect(wiring.imports.match(/webSearch as __t_webSearch/g)?.length).toBe(1);
    expect(wiring.packages).toContain("@crewhaus/tool-web");
    expect(wiring.packages).toContain("@crewhaus/tool-todo");
  });

  test("a step's tool_config emits its init once", () => {
    const wiring = resolveWorkflowTools([
      step({ tools: ["fetch"], toolConfigs: { fetch: { allowedHosts: ["x.test"] } } }),
    ]);
    expect(wiring.inits).toContain('registerFetchConfig({"allowedHosts":["x.test"]})');
  });

  test("mcp__* and custom tools are permitted but unwired + noted", () => {
    const ir: IrWorkflowV0 = { ...baseIr, steps: [step({ tools: ["mcp__s__t", "myThing"] })] };
    const worker = workerCode(ir);
    expect(worker).toContain("permitted but not wired");
    expect(worker).toContain("mcp__s__t");
  });
});

// --- package.json + provider gate + taxonomy ---------------------------------

describe("emitCfWorkerWorkflow — package.json + gates", () => {
  test("package.json sanitizes the spec name and resists JSON injection (#148)", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      name: '", "dependencies": { "evil-typosquat": "1.0.0" }, "x": "',
    };
    const parsed = JSON.parse(
      emitCfWorkerWorkflow(ir).files.find((f) => f.path === "package.json")?.content ?? "",
    ) as { name: string; dependencies: Record<string, string> };
    expect(parsed.name).not.toContain('"');
    // the runtime dep is present, but the injected typosquat is not.
    expect(parsed.dependencies["evil-typosquat"]).toBeUndefined();
    expect(parsed.dependencies["@crewhaus/worker-runtime"]).toBeDefined();
  });

  test("edge-safe tool packages are declared in package.json", () => {
    const ir: IrWorkflowV0 = { ...baseIr, steps: [step({ tools: ["todoWrite"] })] };
    const deps = (
      JSON.parse(
        emitCfWorkerWorkflow(ir).files.find((f) => f.path === "package.json")?.content ?? "",
      ) as { dependencies: Record<string, string> }
    ).dependencies;
    expect(deps["@crewhaus/tool-todo"]).toBeDefined();
  });

  test("a workflow with one openai/ step fails at compile time, naming the step", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      steps: [step({ name: "research" }), step({ name: "draft", model: "openai/gpt-4o-mini" })],
    };
    expect(() => emitCfWorkerWorkflow(ir)).toThrow(
      /cf-worker targets currently support claude-\* models only/,
    );
    expect(() => emitCfWorkerWorkflow(ir)).toThrow(/step "draft"/);
  });

  test("all-claude steps still emit cleanly", () => {
    expect(emitCfWorkerWorkflow(baseIr).files.length).toBe(4);
  });

  test("failure_taxonomy ignored-note appears only when declared", () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    };
    expect(workerCode(ir)).toContain(
      "failure_taxonomy configured but target-cf-worker-workflow does not wire it up",
    );
    expect(workerCode(baseIr)).not.toContain("failure_taxonomy configured");
  });
});

// --- the emitted worker builds -----------------------------------------------

describe("emitCfWorkerWorkflow — the emitted worker builds", () => {
  test("a tools-free workflow bundles for the edge with ZERO node: specifiers", async () => {
    const r = await runJob(workerCode(baseIr), { mode: "build", buildTarget: "browser" });
    expect(r.error).toBeUndefined();
    expect(r.success, JSON.stringify(r.logs)).toBe(true);
    expect(r.nodeFree).toBe(true);
  });

  test("a workflow with an edge-safe tool transpiles with the tool wired in", async () => {
    const ir: IrWorkflowV0 = { ...baseIr, steps: [step({ tools: ["todoWrite"] })] };
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

describe("emitCfWorkerWorkflow — /chat SSE through the shared runtime", () => {
  test("brackets every step with step_start/step_end + per-step usage/cost, then done", async () => {
    // 3 steps, no tools → one model call per step.
    const r = await runJob(workerCode(baseIr), {
      mode: "drive",
      turns: [
        textTurn("research out", { input: 7, output: 3 }),
        textTurn("draft out", { input: 7, output: 3 }),
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
    expect(byKind("step_start")).toHaveLength(3);
    expect(byKind("step_end")).toHaveLength(3);
    expect(byKind("model_response")).toHaveLength(3);
    expect(byKind("cost_accrual")).toHaveLength(3);

    expect(byKind("step_start")[0]?.data).toMatchObject({
      kind: "step_start",
      name: "research",
      step: 1,
      total: 3,
    });
    const responses = byKind("model_response");
    expect(responses[0]?.data).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      usage: { input: 7, output: 3 },
    });
    expect(responses[2]?.data).toMatchObject({ usage: { input: 10, output: 5 } });
    expect(byKind("cost_accrual")[0]?.data).toMatchObject({
      kind: "cost_accrual",
      provider: "anthropic",
      inputTokens: 7,
      outputTokens: 3,
      costUsdMicros: 0,
      unpriced: true,
    });
  });

  test("only the final step streams text; intermediate output threads forward", async () => {
    const r = await runJob(workerCode(baseIr), {
      mode: "drive",
      turns: [textTurn("research out"), textTurn("draft out"), textTurn("Final answer.")],
    });
    const events = parseSse(r.raw ?? "");
    const streamed = events
      .filter((e) => e.name === "text")
      .map((e) => e.data["text"])
      .join("");
    // Step progress markers stream, plus the FINAL step's text — never the
    // intermediate steps' terminal text.
    expect(streamed).toContain("Final answer.");
    expect(streamed).not.toContain("research out");
    expect(streamed).not.toContain("draft out");
  });

  test("a step runs a REAL tool round-trip through the loop", async () => {
    const ir: IrWorkflowV0 = { ...baseIr, steps: [step({ name: "only", tools: ["todoWrite"] })] };
    const r = await runJob(workerCode(ir), {
      mode: "drive",
      turns: [
        toolTurn("t1", "TodoWrite", {
          todos: [{ id: "1", content: "go", status: "pending", priority: "high" }],
        }),
        textTurn("done here"),
      ],
    });
    expect(r.error).toBeUndefined();
    expect(r.calls).toBe(2); // tool round-trip inside the single step
    const kinds = parseSse(r.raw ?? "")
      .filter((e) => e.name === "trace")
      .map((e) => e.data["kind"]);
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_end");
  });

  test("the final step's step_end precedes done", async () => {
    const r = await runJob(workerCode(baseIr), {
      mode: "drive",
      turns: [textTurn("a"), textTurn("b"), textTurn("c")],
    });
    const markers = parseSse(r.raw ?? "")
      .filter((e) => e.name === "trace" || e.name === "done")
      .map((e) => (e.name === "done" ? "done" : (e.data["kind"] as string)));
    expect(markers[markers.length - 1]).toBe("done");
    expect(markers[markers.length - 2]).toBe("step_end");
  });

  test("a step that overflows ends the run with a classified error frame", async () => {
    const ir: IrWorkflowV0 = {
      ...baseIr,
      steps: [step({ name: "only" })],
      limits: { contextLimit: 1 },
    };
    const r = await runJob(workerCode(ir), { mode: "drive", turns: [textTurn("never")] });
    const events = parseSse(r.raw ?? "");
    expect(events.some((e) => e.name === "done")).toBe(false);
    const err = events.find((e) => e.name === "error");
    expect(String(err?.data["message"])).toMatch(/context window exceeded/i);
  });

  // IrWorkflowV0 does not yet carry `observability`; the emitter reads it
  // structurally (forward-compatible gate).
  const withObs = (level: string): IrWorkflowV0 =>
    ({ ...baseIr, observability: { trace: { level } } }) as unknown as IrWorkflowV0;

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
