/**
 * Evals Wave 4, cluster S — bridge-smoke DRIVER. Spawned by
 * `apps/cli/src/eval-bridge-smoke.test.ts` as `bun driver.ts <mode> <bundleDir>`
 * (cwd = repo root): under `bun run`, a compiled bundle in a manifest-free
 * tmp dir resolves its `@crewhaus/*` imports against the in-tree workspace,
 * which `bun test`'s resolver does not do for out-of-tree files — so the
 * test asserts on this driver's single `RESULT:{json}` stdout line instead.
 *
 * Modes drive the compiled bundle's ACTUAL runtime entry with a scripted
 * provider adapter (no credentials, no network):
 *   workflow — createBridgeInvoker + a full runEval (grades + artifacts);
 *   graph    — runForEval to run_done on a subscribed RunContext;
 *   crew     — runForEval through the compiled orchestrator;
 *   pipeline — runForEval with seeded history through the indexed agent.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { runEval } from "@crewhaus/eval-runner";
import type { IrV0 } from "@crewhaus/ir";
import { createRunContext } from "@crewhaus/run-context";
import { createBridgeInvoker } from "@crewhaus/target-eval-bundle";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

function scriptedAdapter(prefix: string): ProviderAdapter {
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
    stream: ({ messages }) => {
      const last = messages[messages.length - 1];
      let seed = "";
      if (last && typeof last.content === "string") seed = last.content;
      else if (last && Array.isArray(last.content)) {
        for (const block of last.content) {
          if ("text" in block && typeof block.text === "string") seed = block.text;
        }
      }
      const text = `${prefix}${seed.slice(0, 40).replace(/\n/g, " ")}`;
      return (async function* () {
        yield { kind: "message_start" } as StreamEvent;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        } as StreamEvent;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        } as StreamEvent;
        yield { kind: "content_block_stop", index: 0 } as StreamEvent;
        yield { kind: "message_delta", stopReason: "end_turn" } as StreamEvent;
        yield { kind: "message_stop" } as StreamEvent;
      })();
    },
  };
}

type RunForEvalFn = (input: string, opts?: Record<string, unknown>) => Promise<string>;

const mode = process.argv[2];
const bundleDir = process.argv[3];
if (mode === undefined || bundleDir === undefined) {
  throw new Error("usage: bun driver.ts <workflow|graph|crew|pipeline> <bundleDir>");
}

const result: Record<string, unknown> = {};

if (mode === "workflow") {
  const entry = (await import(join(bundleDir, "agent.ts"))) as Record<string, unknown>;
  result["hasRunForEval"] = typeof entry["runForEval"] === "function";
  const bridge = {
    sourceTarget: "workflow",
    kind: "workflow-run",
    chatCapable: false,
    entryImport: "../agent.ts",
  } as const;
  // 1 — the invoker seam: both compiled steps run on the per-sample bus.
  const invoker = createBridgeInvoker(bridge, entry, { _adapter: scriptedAdapter("wf:") });
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const invoked = await invoker({
    sample: { id: "s1", input: "write a haiku" },
    runContext,
    sessionRootDir: mkdtempSync(join(tmpdir(), "wf-sample-")),
  });
  result["agentOutput"] = invoked.agentOutput;
  result["modelResponses"] = events.filter((e) => e.kind === "model_response").length;
  result["hasTurnStart"] = events.some((e) => e.kind === "turn_start");

  // 2 — full runEval through the same invoker: grades + persisted artifacts.
  // The same deterministic default the bridge projects (`expected_contains`
  // — passes when the gold expected_output is a substring of the output).
  const { compiled } = parseGradersConfig(
    "graders:\n  - name: has-prefix\n    type: expected_contains\n",
  );
  const ir: IrV0 = {
    version: 0,
    name: "mini-flow",
    target: "cli",
    agent: { model: "claude-sonnet-4-6", instructions: "(bridge descriptor)" },
    tools: [],
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},
  };
  const evalOut = mkdtempSync(join(tmpdir(), "wf-eval-"));
  const summary = await runEval({
    ir,
    dataset: {
      name: "wf-smoke",
      samples: (async function* () {
        yield { id: "a", input: "first ask", expected_output: "wf:" };
      })(),
    },
    compiledGraders: compiled,
    opts: {
      invoker: createBridgeInvoker(bridge, entry, { _adapter: scriptedAdapter("wf:") }),
      outDir: evalOut,
      concurrency: 1,
    },
  });
  result["passRate"] = summary.aggregates.passRate;
  const persisted = readFileSync(join(evalOut, "a", "events.jsonl"), "utf-8");
  result["persistedModelResponses"] = persisted
    .split("\n")
    .filter((l) => l.includes('"model_response"')).length;
} else if (mode === "graph") {
  const entry = (await import(join(bundleDir, "agent.ts"))) as Record<string, unknown>;
  const runForEval = entry["runForEval"] as RunForEvalFn;
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const output = await runForEval("what's the plan?", {
    runContext,
    _adapter: scriptedAdapter("node:"),
  });
  result["state"] = JSON.parse(output);
  result["modelResponses"] = events.filter((e) => e.kind === "model_response").length;
} else if (mode === "crew") {
  const entry = (await import(join(bundleDir, "eval-entry.ts"))) as Record<string, unknown>;
  const runForEval = entry["runForEval"] as RunForEvalFn;
  const sessionRoot = mkdtempSync(join(tmpdir(), "crew-sessions-"));
  const output = await runForEval("say hi", {
    sessionRootDir: sessionRoot,
    _adapter: scriptedAdapter("crew:"),
  });
  result["output"] = output;
  result["sessionRoot"] = sessionRoot;
} else if (mode === "pipeline") {
  const entry = (await import(join(bundleDir, "agent.ts"))) as Record<string, unknown>;
  const runForEval = entry["runForEval"] as RunForEvalFn;
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const output = await runForEval("what does the fox do?", {
    runContext,
    sessionRootDir: mkdtempSync(join(tmpdir(), "pipe-sessions-")),
    _adapter: scriptedAdapter("rag:"),
    history: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi!" },
    ],
  });
  result["output"] = output;
  result["modelResponses"] = events.filter((e) => e.kind === "model_response").length;
} else {
  throw new Error(`unknown mode "${mode}"`);
}

console.log(`RESULT:${JSON.stringify(result)}`);
