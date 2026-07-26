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
 *   pipeline — runForEval with seeded history through the indexed agent;
 *   channel  — createBridgeInvoker over the bot's REAL createAgent().runTurn,
 *              history-less AND history-carrying (the resume path);
 *   managed  — createBridgeInvoker over the gateway's runOneTurn dispatcher,
 *              history-less AND history-carrying (extraOptions.seedMessages).
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
  throw new Error(
    "usage: bun driver.ts <workflow|graph|crew|pipeline|channel|managed> <bundleDir>",
  );
}

const HISTORY = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi!" },
] as const;

/** Every `user_message` payload recorded in a sample dir's session transcript,
 *  in order — proof the seeded history actually reached the session log. */
function transcriptUserMessages(sampleDir: string, sessionId: string): string[] {
  const path = join(sampleDir, `${sessionId}.jsonl`);
  const out: string[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.length === 0) continue;
    const ev = JSON.parse(line) as { kind?: string; payload?: { content?: unknown } };
    if (ev.kind === "user_message" && typeof ev.payload?.content === "string") {
      out.push(ev.payload.content);
    }
  }
  return out;
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

  // 3 — CREWHAUS_RUN_ID (the documented durable-resume knob, a plausible
  // CI/harness export) must NOT collapse samples into one idempotency
  // namespace: two invocations under a pinned run id must each execute their
  // steps, not replay invocation 1's outputs out of the module-scope store.
  process.env["CREWHAUS_RUN_ID"] = "pinned_by_the_harness";
  const runForEvalDirect = entry["runForEval"] as RunForEvalFn;
  await runForEvalDirect("first sample", { _adapter: scriptedAdapter("wf:") });
  const secondCtx = createRunContext();
  const secondEvents: TraceEvent[] = [];
  secondCtx.eventBus.subscribe((e) => secondEvents.push(e));
  const secondOut = await runForEvalDirect("second sample", {
    runContext: secondCtx,
    _adapter: scriptedAdapter("second:"),
  });
  result["pinnedRunIdSecondModelResponses"] = secondEvents.filter(
    (e) => e.kind === "model_response",
  ).length;
  result["pinnedRunIdSecondOutput"] = secondOut;
} else if (mode === "graph") {
  const entry = (await import(join(bundleDir, "agent.ts"))) as Record<string, unknown>;
  const runForEval = entry["runForEval"] as RunForEvalFn;
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  // A sandboxed sample dir: every node's session log must land HERE (the
  // runner reads `<sampleDir>/<sessionId>.jsonl` to build transcript.jsonl),
  // never in the process cwd's .crewhaus/sessions/.
  const sampleDir = mkdtempSync(join(tmpdir(), "graph-sample-"));
  const cwdSessions = join(process.cwd(), ".crewhaus", "sessions");
  const countCwdSessions = (): number => {
    try {
      return readdirSync(cwdSessions).length;
    } catch {
      return 0;
    }
  };
  const before = countCwdSessions();
  const output = await runForEval("what's the plan?", {
    runContext,
    sessionRootDir: sampleDir,
    _adapter: scriptedAdapter("node:"),
  });
  result["state"] = JSON.parse(output);
  result["modelResponses"] = events.filter((e) => e.kind === "model_response").length;
  result["sampleSessionLogs"] = readdirSync(sampleDir).filter((f) => f.endsWith(".jsonl")).length;
  // Nothing may land in the operator's working directory.
  result["cwdSessionsAdded"] = countCwdSessions() - before;
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
} else if (mode === "channel") {
  // The bot's REAL createAgent().runTurn behind the loopback: inbound
  // classification + the session resume machinery, driven through the same
  // createBridgeInvoker the emitted bundle wires.
  const entry = (await import(join(bundleDir, "eval-entry.ts"))) as Record<string, unknown>;
  result["hasRunForEval"] = typeof entry["runForEval"] === "function";
  const bridge = {
    sourceTarget: "channel",
    kind: "channel-resume-turn",
    chatCapable: true,
    entryImport: "../eval-entry.ts",
  } as const;
  const invoker = createBridgeInvoker(bridge, entry, { _adapter: scriptedAdapter("chan:") });

  // (a) history-less sample — the fresh-session path.
  const freshDir = mkdtempSync(join(tmpdir(), "chan-sample-fresh-"));
  const freshCtx = createRunContext();
  const fresh = await invoker({
    sample: { id: "fresh", input: "first ask" },
    runContext: freshCtx,
    sessionRootDir: freshDir,
  });
  result["freshOutput"] = fresh.agentOutput;
  result["freshFiles"] = readdirSync(freshDir).sort();
  result["freshSessionId"] = freshCtx.sessionId;

  // (b) history-carrying sample — the REAL resume path (isNew: false), which
  // reads the session RECORD before replaying the seeded event log.
  const resumeDir = mkdtempSync(join(tmpdir(), "chan-sample-resume-"));
  const resumeCtx = createRunContext();
  const resumed = await invoker({
    sample: { id: "resumed", input: "follow-up", history: [...HISTORY] },
    runContext: resumeCtx,
    sessionRootDir: resumeDir,
  });
  result["resumeOutput"] = resumed.agentOutput;
  result["resumeFiles"] = readdirSync(resumeDir).sort();
  result["resumeSessionId"] = resumeCtx.sessionId;
  result["resumeUserMessages"] = transcriptUserMessages(resumeDir, resumeCtx.sessionId);
} else if (mode === "managed") {
  // The gateway's runOneTurn dispatcher under an isolated per-sample tenant.
  const entry = (await import(join(bundleDir, "agent.ts"))) as Record<string, unknown>;
  result["hasRunOneTurn"] = typeof entry["runOneTurn"] === "function";
  const bridge = {
    sourceTarget: "managed",
    kind: "gateway-request",
    chatCapable: true,
    entryImport: "../agent.ts",
  } as const;
  const invoker = createBridgeInvoker(bridge, entry, { _adapter: scriptedAdapter("mg:") });

  const freshDir = mkdtempSync(join(tmpdir(), "mg-sample-fresh-"));
  const freshCtx = createRunContext();
  const freshEvents: TraceEvent[] = [];
  freshCtx.eventBus.subscribe((e) => freshEvents.push(e));
  const fresh = await invoker({
    sample: { id: "fresh", input: "first ask" },
    runContext: freshCtx,
    sessionRootDir: freshDir,
  });
  result["freshOutput"] = fresh.agentOutput;
  result["freshModelResponses"] = freshEvents.filter((e) => e.kind === "model_response").length;
  result["freshFiles"] = readdirSync(freshDir).sort();

  const histDir = mkdtempSync(join(tmpdir(), "mg-sample-hist-"));
  const histCtx = createRunContext();
  const hist = await invoker({
    sample: { id: "hist", input: "follow-up", history: [...HISTORY] },
    runContext: histCtx,
    sessionRootDir: histDir,
  });
  result["historyOutput"] = hist.agentOutput;
  result["historyFiles"] = readdirSync(histDir).sort();
  result["historySessionId"] = histCtx.sessionId;
  result["historyUserMessages"] = transcriptUserMessages(histDir, histCtx.sessionId);
} else {
  throw new Error(`unknown mode "${mode}"`);
}

console.log(`RESULT:${JSON.stringify(result)}`);
