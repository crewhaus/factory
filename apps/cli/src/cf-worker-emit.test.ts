import { describe, expect, test } from "bun:test";
import { lower } from "@crewhaus/compiler";
import { CompilerError } from "@crewhaus/errors";
import { parseSpec } from "@crewhaus/spec";
import { CF_WORKER_EMIT_TARGETS, emitCfWorkerBundle } from "./cf-worker-emit";

/** Lower a YAML spec to its IR, the exact input the CLI hands emitCfWorkerBundle. */
function ir(yaml: string): ReturnType<typeof lower> {
  return lower(parseSpec(yaml));
}

const CLI_SPEC = `
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
`;

const WORKFLOW_SPEC = `
name: wf
target: workflow
model: claude-sonnet-4-6
steps:
  - name: one
    instructions: do the first thing
  - name: two
    instructions: do the second thing
`;

const GRAPH_SPEC = `
name: gr
target: graph
model: claude-sonnet-4-6
entry: a
nodes:
  a:
    instructions: do a
  b:
    instructions: do b
edges:
  - from: a
    to: b
`;

const CHANNEL_SPEC = `
name: ch
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: channel
`;

describe("emitCfWorkerBundle", () => {
  test("cli target emits a worker.js bundle", () => {
    const bundle = emitCfWorkerBundle(ir(CLI_SPEC));
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker).toBeDefined();
    expect(worker?.content).toContain("fetch");
  });

  test("workflow target emits a worker.js bundle", () => {
    const bundle = emitCfWorkerBundle(ir(WORKFLOW_SPEC));
    expect(bundle.files.some((f) => f.path === "worker.js")).toBe(true);
  });

  test("graph target emits a worker.js bundle", () => {
    const bundle = emitCfWorkerBundle(ir(GRAPH_SPEC));
    expect(bundle.files.some((f) => f.path === "worker.js")).toBe(true);
  });

  test("bundle is byte-identical to calling the emitter directly (faithful mirror)", async () => {
    const { emitCfWorkerCli } = await import("@crewhaus/target-cf-worker-cli");
    const viaSwitch = emitCfWorkerBundle(ir(CLI_SPEC));
    const direct = emitCfWorkerCli(ir(CLI_SPEC) as never);
    expect(viaSwitch).toEqual(direct);
  });

  test("threads allowedOrigins into the emitted worker", () => {
    const bundle = emitCfWorkerBundle(ir(CLI_SPEC), {
      allowedOrigins: ["https://example.test"],
    });
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker?.content).toContain("https://example.test");
  });

  test("unsupported target (channel) throws CompilerError naming the supported set", () => {
    let thrown: unknown;
    try {
      emitCfWorkerBundle(ir(CHANNEL_SPEC));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CompilerError);
    expect((thrown as Error).message).toContain("cf-worker emit supports target=");
    expect((thrown as Error).message).toContain("got channel");
    // The message lists exactly cli|workflow|graph.
    expect((thrown as Error).message).toContain(CF_WORKER_EMIT_TARGETS.join("|"));
  });

  test("CF_WORKER_EMIT_TARGETS is the cli/workflow/graph set", () => {
    expect([...CF_WORKER_EMIT_TARGETS]).toEqual(["cli", "workflow", "graph"]);
  });
});
