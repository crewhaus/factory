/**
 * The composition root's gates inside the LIVE `runChatLoop` (runtime-core
 * owns the gate; this package builds its closures): a scripted model, the
 * real session event log, the real verifier, the real stores. What a compiled
 * bundle or `crewhaus run` gets from `wireEvaluation`, run the way they run it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@crewhaus/logging";
import { type ProofBundle, proofsRoot } from "@crewhaus/provability";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { config, sumTool, tempDirs } from "./__fixtures__/helpers";
import { mergeGateTools } from "./tools";
import { wireEvaluation } from "./wire";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

type Adapter = NonNullable<Parameters<typeof runChatLoop>[0]["_adapter"]>;
type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/** A model that answers each call with the next scripted content (the last repeats). */
function scriptedModel(scripts: ReadonlyArray<ReadonlyArray<Block>>): Adapter & {
  readonly toolNames: string[][];
  calls(): number;
} {
  let i = 0;
  const toolNames: string[][] = [];
  const adapter = {
    toolNames,
    calls: () => i,
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: { tools?: ReadonlyArray<{ name: string }> }) {
      toolNames.push((req.tools ?? []).map((t) => t.name));
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      i += 1;
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" };
        for (let idx = 0; idx < content.length; idx += 1) {
          const block = content[idx] as Block;
          if (block.type === "text") {
            yield { kind: "content_block_start", index: idx, block: { type: "text", text: "" } };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            };
          } else {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            };
          }
          yield { kind: "content_block_stop", index: idx };
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
  return adapter as unknown as Adapter & { readonly toolNames: string[][]; calls(): number };
}

const URL_A = "https://acme.example/policy";
const PAGE = `URL: ${URL_A}\nStatus: 200\nContent-Type: text/html\n\nThe refund window is 14 days from the date of purchase.`;
const ANSWER = `The refund window is 14 days [1].\n\n[1]: ${URL_A}`;

/** A WebFetch stand-in: the builtin reader's name and input, a fixed page, no network. */
const webFetch: RegisteredTool = buildTool({
  name: "WebFetch",
  description: "fetch a page",
  inputSchema: z.object({ url: z.string() }).strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async () => PAGE,
});

async function runTurn(opts: {
  readonly model: Adapter;
  readonly tools: ReadonlyArray<RegisteredTool>;
  readonly gates: Awaited<ReturnType<typeof wireEvaluation>>;
  readonly sessionRootDir: string;
  /** Default `bypass`; `default` runs the bundles' own permission floor (builtin rules only). */
  readonly permissionMode?: "bypass" | "default";
  readonly extra?: Partial<Parameters<typeof runChatLoop>[0]>;
}) {
  const runContext = createRunContext({
    logger: createLogger({ level: "error", format: "json", sink: () => {} }),
  });
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((event) => {
    events.push(event);
  });
  const stdout: string[] = [];
  const result = await runChatLoop({
    model: "test-model",
    instructions: "cite everything",
    runContext,
    sessionRootDir: opts.sessionRootDir,
    singleTurn: true,
    seedMessages: [{ role: "user", content: "what is the refund window?" }],
    permissionMode: opts.permissionMode ?? "bypass",
    spinner: false,
    stdout: (s) => {
      stdout.push(s);
    },
    _adapter: opts.model,
    tools: mergeGateTools(opts.tools, opts.gates),
    ...(opts.gates.evaluation !== undefined ? { evaluation: opts.gates.evaluation } : {}),
    ...(opts.gates.provability !== undefined ? { provability: opts.gates.provability } : {}),
    ...opts.extra,
  });
  const graded = events.filter((e) => e.kind === "provability_graded") as Array<
    TraceEvent & { verdict: string; retryIndex: number }
  >;
  const decisions = events.filter((e) => e.kind === "permission_decision") as Array<
    TraceEvent & { toolName: string; decision: string; outcome?: string }
  >;
  return {
    result,
    sessionId: runContext.sessionId,
    graded,
    decisions,
    stdout: stdout.join(""),
  };
}

describe("wireEvaluation's gate in the live loop", () => {
  test("design scenario A: unfetched citation fails, the model fetches, the retry passes; footer on the reply, bundle on disk", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, ".crewhaus", "sessions");
    const gates = await wireEvaluation(
      { specName: "support-bot", primaryModel: "test-model", provability: config("grounded") },
      { cwd, sessionRootDir, footerTarget: "reply", catalog: [webFetch] },
    );
    const model = scriptedModel([
      [{ type: "text", text: ANSWER }],
      [{ type: "tool_use", id: "toolu_fetch1", name: "WebFetch", input: { url: URL_A } }],
      [{ type: "text", text: ANSWER }],
    ]);
    const run = await runTurn({ model, tools: [webFetch], gates, sessionRootDir });
    expect(model.calls()).toBe(3);
    expect(run.graded.map((e) => [e.verdict, e.retryIndex])).toEqual([
      ["fail", 0],
      ["pass", 1],
    ]);
    // The proof tools rode the run's tool list from the first call.
    expect(model.toolNames[0]).toContain("ProvabilityPreflight");
    // footerTarget "reply": the footer is part of the returned text, after a blank line.
    const root = proofsRoot(cwd, "support-bot");
    const bundleDir = join(root, run.sessionId);
    expect(run.result).toStartWith(
      `${ANSWER}\n\n── provability · grounded ✓ · 1/1 claim · 1 source · 0 assumptions · .crewhaus`,
    );
    expect(run.stdout).not.toContain("── provability");
    // The standing bundle was persisted under the spec's proofs root, per session.
    const turnFile = /(turn-\d+\.json)$/.exec(run.result ?? "")?.[1] as string;
    const persisted = JSON.parse(readFileSync(join(bundleDir, turnFile), "utf8")) as ProofBundle;
    expect(persisted.verdict).toBe("pass");
    expect(persisted.retryIndex).toBe(1);
  });

  test("checked: the model computes with a pure tool and cites it; the gate replays it through the run's tool list", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, "sessions");
    let runs = 0;
    const sum = sumTool("SumFake", (a, b) => {
      runs += 1;
      return `The sum is ${a + b}.`;
    });
    const gates = await wireEvaluation(
      { specName: "calc-bot", primaryModel: "test-model", provability: config("checked") },
      { cwd, sessionRootDir, footerTarget: "reply", catalog: [sum] },
    );
    const model = scriptedModel([
      [{ type: "tool_use", id: "toolu_sum1", name: "SumFake", input: { a: 2, b: 40 } }],
      [{ type: "text", text: "The sum is 42 [1].\n\n[1]: tool:toolu_sum1" }],
    ]);
    const run = await runTurn({ model, tools: [sum], gates, sessionRootDir });
    expect(run.graded.map((e) => e.verdict)).toEqual(["pass"]);
    // Once by the model's call, once by the gate's replay.
    expect(runs).toBe(2);
    expect(existsSync(join(proofsRoot(cwd, "calc-bot"), run.sessionId))).toBe(true);
  });

  test("evaluation and provability together, from one wiring", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, "sessions");
    const gates = await wireEvaluation(
      {
        specName: "both-bot",
        primaryModel: "test-model",
        evaluation: { grader: { type: "contains", value: "[1]" }, onFail: "retry", maxRetries: 1 },
        provability: { ...config("cited"), render: "none" },
      },
      { cwd, sessionRootDir, footerTarget: "reply" },
    );
    const model = scriptedModel([[{ type: "text", text: ANSWER }]]);
    const run = await runTurn({ model, tools: [], gates, sessionRootDir });
    // render: none — the answer is served bare, the verdict still recorded.
    expect(run.result).toBe(ANSWER);
    expect(run.graded.map((e) => e.verdict)).toEqual(["pass"]);
    expect(model.calls()).toBe(1);
  });

  test("checked: a pure tool's output over the spill threshold replays against the preview the runtime logged", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, "sessions");
    let runs = 0;
    const big = sumTool("SumFake", (a, b) => {
      runs += 1;
      return `The sum is ${a + b}.\n${Array.from({ length: 2000 }, (_, k) => `row ${k}: ${k * 2}`).join("\n")}`;
    });
    const gates = await wireEvaluation(
      {
        specName: "calc-bot",
        primaryModel: "test-model",
        provability: config("checked", { onFail: "note", maxRetries: 0 }),
      },
      { cwd, sessionRootDir, footerTarget: "reply", catalog: [big] },
    );
    const model = scriptedModel([
      [{ type: "tool_use", id: "toolu_sum1", name: "SumFake", input: { a: 2, b: 40 } }],
      [{ type: "text", text: "The sum is 42 [1].\n\n[1]: tool:toolu_sum1" }],
    ]);
    const run = await runTurn({ model, tools: [big], gates, sessionRootDir });
    expect(run.graded.map((e) => e.verdict)).toEqual(["pass"]);
    // The model's call and ONE replay: its head matched the logged preview.
    expect(runs).toBe(2);
    const turnFile = /(turn-\d+\.json)$/.exec(run.result ?? "")?.[1] as string;
    const bundle = JSON.parse(
      readFileSync(join(proofsRoot(cwd, "calc-bot"), run.sessionId, turnFile), "utf8"),
    ) as ProofBundle;
    expect(bundle.claims[0]?.bindings[0]).toMatchObject({ ok: true, replayed: true });
  });

  test("the bundles' own permission floor: the gate's preflight runs unprompted; nothing parks", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, "sessions");
    const gates = await wireEvaluation(
      { specName: "support-bot", primaryModel: "test-model", provability: config("cited") },
      { cwd, sessionRootDir, footerTarget: "reply" },
    );
    const model = scriptedModel([
      [
        {
          type: "tool_use",
          id: "toolu_pre1",
          name: "ProvabilityPreflight",
          input: { draft: ANSWER },
        },
      ],
      [{ type: "text", text: ANSWER }],
    ]);
    // No bypass, no permission rules: only the builtin defaults every bundle
    // falls back to — where an unruled call asks, and a headless ask parks.
    const run = await runTurn({
      model,
      tools: [],
      gates,
      sessionRootDir,
      permissionMode: "default",
    });
    expect(run.decisions.map((d) => [d.toolName, d.decision])).toEqual([
      ["ProvabilityPreflight", "allow"],
    ]);
    expect(run.graded.map((e) => e.verdict)).toEqual(["pass"]);
    expect(model.calls()).toBe(2);
  });

  test("the runtime hands the gate the run's judge-share read and egress sink: a HEAD lands as an egress_decision", async () => {
    const cwd = dirs.make();
    const sessionRootDir = join(cwd, "sessions");
    const gates = await wireEvaluation(
      {
        specName: "support-bot",
        primaryModel: "test-model",
        provability: config("cited", { sources: { resolve: "head" } }),
      },
      { cwd, sessionRootDir, footerTarget: "reply", resolveHead: async () => 200 },
    );
    const provability = gates.provability as NonNullable<typeof gates.provability>;
    const seen: Array<Parameters<typeof provability.verify>[0]> = [];
    const watched = {
      ...gates,
      provability: {
        ...provability,
        verify: (turn: Parameters<typeof provability.verify>[0]) => {
          seen.push(turn);
          return provability.verify(turn);
        },
      },
    };
    const appended: Array<{ kind: string; payload: unknown }> = [];
    const run = await runTurn({
      model: scriptedModel([[{ type: "text", text: ANSWER }]]),
      tools: [],
      gates: watched,
      sessionRootDir,
      extra: {
        budget: { usdMicros: 5_000_000, onExceed: { kind: "stop" } },
        egressAuditSink: {
          append: async (entry) => {
            appended.push(entry);
          },
        },
      },
    });
    expect(run.graded.map((e) => e.verdict)).toEqual(["pass"]);
    expect(typeof seen[0]?.judgeShareExhausted).toBe("function");
    expect(seen[0]?.judgeShareExhausted?.()).toBe(false);
    expect(appended).toEqual([
      {
        kind: "egress_decision",
        payload: {
          sinkId: "provability.resolve",
          sinkScope: "external",
          method: "HEAD",
          host: "acme.example",
          verdict: "pass",
          status: 200,
        },
      },
    ]);
  });
});
