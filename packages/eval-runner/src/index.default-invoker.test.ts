/**
 * Isolated test for `runEval`'s built-in `defaultInvoker` — the production
 * path taken when the caller supplies no `opts.invoker`. It wires the agent
 * stack once via `wireRunOnce`, then drives `runChatLoop` per sample.
 *
 * We stub both `./wire-once` and `@crewhaus/runtime-core` so nothing real is
 * spun up (no tools, no MCP, no model call). The stub `runChatLoop` records
 * the options it was handed so we can assert the per-sample session name, the
 * forced `permissionMode: "auto"`, `singleTurn`, and the seeded user message.
 * `mock.module` is process-global, so this lives in its own file.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";

type ChatLoopCall = Record<string, unknown>;
const chatLoopCalls: ChatLoopCall[] = [];
const wireCalls: Array<{ cwd?: string }> = [];

// Capture real modules so `afterAll` can restore them — `mock.module` is
// process-global and does not auto-restore across test files. Each capture is
// a plain-object SNAPSHOT (`{ ...ns }`): an ESM namespace is a live view that
// resolves to the stubs once mock.module patches the module, so restoring
// from the namespace itself would silently reinstall the stubs.
const realWireOnce = { ...(await import("./wire-once")) };
const realRuntimeCore = { ...(await import("@crewhaus/runtime-core")) };

// Toggle whether the wired deps include sub-agents (drives the optional
// subAgents/spawnSubAgent spread in defaultInvoker).
let includeSubAgents = false;

function baseDeps() {
  return {
    tools: [],
    hooks: [],
    skills: [],
    slashCommands: new Map(),
    permissionRules: { flag: [], settings: [], yaml: [], hooks: [], builtin: [] },
    model: "claude-wired",
    instructions: "wired instructions",
    sessionName: "wired-session",
    sessionTarget: "cli",
  };
}

mock.module("./wire-once", () => ({
  wireRunOnce: async (_ir: unknown, opts: { cwd?: string } = {}) => {
    wireCalls.push(opts);
    if (includeSubAgents) {
      return {
        ...baseDeps(),
        subAgents: new Map([["helper", { name: "helper" }]]),
        spawnSubAgent: () => undefined,
      };
    }
    return baseDeps();
  },
}));

mock.module("@crewhaus/runtime-core", () => ({
  ...realRuntimeCore,
  runChatLoop: async (opts: ChatLoopCall) => {
    chatLoopCalls.push(opts);
    return `answer for ${(opts["seedMessages"] as Array<{ content: string }>)[0]?.content}`;
  },
}));

const { runEval } = await import("./index");

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

const SPEC = `name: default-invoker-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: spec instructions
`;

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-definvoker-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  mock.module("./wire-once", () => realWireOnce);
  mock.module("@crewhaus/runtime-core", () => realRuntimeCore);
});

describe("runEval — defaultInvoker (no caller invoker)", () => {
  test("wires once, drives runChatLoop per sample (no sub-agents)", async () => {
    const outDir = newTempRoot();
    chatLoopCalls.length = 0;
    wireCalls.length = 0;
    includeSubAgents = false;

    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [
      { id: "a", input: "first", expected_output: "answer for first" },
      { id: "b", input: "second", expected_output: "answer for second" },
    ];
    const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");

    const summary = await runEval({
      ir,
      dataset: { name: "def", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      // No invoker → defaultInvoker path. cwd threads into wireRunOnce.
      opts: { outDir, cwd: "/tmp/some-cwd" },
    });

    // wireRunOnce called exactly once, with the cwd.
    expect(wireCalls).toHaveLength(1);
    expect(wireCalls[0]).toEqual({ cwd: "/tmp/some-cwd" });

    // runChatLoop invoked per sample with the wired stack + forced options.
    expect(chatLoopCalls).toHaveLength(2);
    const call = chatLoopCalls.find(
      (c) => (c["seedMessages"] as Array<{ content: string }>)[0]?.content === "first",
    );
    expect(call?.["permissionMode"]).toBe("auto");
    expect(call?.["singleTurn"]).toBe(true);
    expect(call?.["model"]).toBe("claude-wired");
    expect(call?.["instructions"]).toBe("wired instructions");
    expect(call?.["sessionName"]).toBe("wired-session_a");
    expect(call?.["subAgents"]).toBeUndefined();
    expect(call?.["spawnSubAgent"]).toBeUndefined();

    // The agentOutput flowed back through to grading (exact_match passes).
    expect(summary.aggregates.passRate).toBe(1);
    expect(summary.samples.find((s) => s.sampleId === "a")?.agentOutput).toBe("answer for first");
  });

  test("threads sub-agents through to runChatLoop when wired", async () => {
    const outDir = newTempRoot();
    chatLoopCalls.length = 0;
    wireCalls.length = 0;
    includeSubAgents = true;

    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "a", input: "q", expected_output: "answer for q" }];
    const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");

    await runEval({
      ir,
      dataset: { name: "def-sub", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      // No cwd → wireRunOnce receives `{}` (the cwd-absent spread branch).
      opts: { outDir },
    });

    expect(wireCalls[0]).toEqual({});
    expect(chatLoopCalls).toHaveLength(1);
    const call = chatLoopCalls[0];
    expect(call?.["subAgents"]).toBeInstanceOf(Map);
    expect(typeof call?.["spawnSubAgent"]).toBe("function");
  });
});
