import { describe, expect, test } from "bun:test";
import { lower } from "@crewhaus/compiler";
import { CompilerError } from "@crewhaus/errors";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { CF_WORKER_EMIT_TARGETS, emitCfWorkerBundle } from "./cf-worker-emit";

/** A YAML spec, parsed and lowered: the exact inputs the CLI hands emitCfWorkerBundle. */
function ir(yaml: string): [Spec, ReturnType<typeof lower>] {
  const spec = parseSpec(yaml);
  return [spec, lower(spec)];
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
    const bundle = emitCfWorkerBundle(...ir(CLI_SPEC));
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker).toBeDefined();
    expect(worker?.content).toContain("fetch");
  });

  test("workflow target emits a worker.js bundle", () => {
    const bundle = emitCfWorkerBundle(...ir(WORKFLOW_SPEC));
    expect(bundle.files.some((f) => f.path === "worker.js")).toBe(true);
  });

  test("graph target emits a worker.js bundle", () => {
    const bundle = emitCfWorkerBundle(...ir(GRAPH_SPEC));
    expect(bundle.files.some((f) => f.path === "worker.js")).toBe(true);
  });

  test("bundle is byte-identical to calling the emitter directly (faithful mirror)", async () => {
    const { emitCfWorkerCli } = await import("@crewhaus/target-cf-worker-cli");
    const viaSwitch = emitCfWorkerBundle(...ir(CLI_SPEC));
    const direct = emitCfWorkerCli(ir(CLI_SPEC)[1] as never);
    expect(viaSwitch.files).toEqual(direct.files);
    expect(viaSwitch.warnings).toEqual([]);
  });

  test("a builtin the edge does not run is a warning naming it, and is left out (shape-reach#4)", () => {
    const spec =
      "name: w\ntarget: cli\nagent: { model: claude-sonnet-4-6, instructions: i }\ntools: [webFetch, gitStatus, jsonQuery]\npermissions: { rules: [{ type: alwaysAllow, pattern: WebFetch }] }\n";
    const bundle = emitCfWorkerBundle(...ir(spec));
    expect(bundle.warnings.map((w) => w.code)).toEqual(["edge-unsafe-tool", "edge-unsafe-tool"]);
    expect(bundle.warnings[0]?.message).toContain(
      'tool "gitStatus" is a builtin, but the cf-worker target cannot run it: it starts a host process',
    );
    expect(bundle.warnings[1]?.message).toContain("the edge worker does not wire it");
    const worker = bundle.files.find((f) => f.path === "worker.js")?.content ?? "";
    expect(worker).toContain("__t_webFetch");
    expect(worker).not.toContain("tool-git");
    const readme = bundle.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("| `gitStatus` | agent | not wired |");
  });

  // 0.8.0 §1, §3 (review I40) — the edge serves answers ungated: a declared
  // provability: or evaluation: block is said, and --strict (which escalates
  // accepted-but-unwired) fails, instead of a byte-identical silent worker.
  test("a provability: or evaluation: block the edge does not run is an accepted-but-unwired warning", () => {
    const base =
      "name: w\ntarget: cli\nagent: { model: claude-sonnet-4-6, instructions: i }\ntools: [webFetch]\npermissions: { rules: [{ type: alwaysAllow, pattern: WebFetch }] }\n";
    expect(emitCfWorkerBundle(...ir(base)).warnings).toEqual([]);

    const gated = emitCfWorkerBundle(...ir(`${base}provability: { level: grounded }\n`));
    expect(gated.warnings).toEqual([
      {
        code: "accepted-but-unwired",
        path: "provability",
        message: expect.stringContaining("the worker serves every answer ungated"),
      },
    ]);
    // Said, not wired: the worker itself is the ungated one.
    expect(gated.files.find((f) => f.path === "worker.js")?.content).toBe(
      emitCfWorkerBundle(...ir(base)).files.find((f) => f.path === "worker.js")?.content,
    );

    const judged = emitCfWorkerBundle(
      ...ir(`${base}evaluation:\n  grader:\n    type: llm_judge\n    criteria: helpful\n`),
    );
    expect(judged.warnings.map((w) => [w.code, w.path])).toEqual([
      ["accepted-but-unwired", "evaluation"],
    ]);
    // A block parked at level: off lowers to none: nothing on the edge to warn about.
    expect(
      emitCfWorkerBundle(...ir(`${base}provability: off\n`)).warnings.map((w) => w.path),
    ).toEqual([]);
  });

  test("a wired tool no alwaysAllow rule covers is an informational edge-tool-needs-allow notice", () => {
    const unruled =
      "name: w\ntarget: cli\nagent: { model: claude-sonnet-4-6, instructions: i }\ntools: [webFetch]\n";
    expect(emitCfWorkerBundle(...ir(unruled)).warnings).toEqual([
      {
        code: "edge-tool-needs-allow",
        path: "tools",
        message:
          "`WebFetch` runs on a Cloudflare Worker only when an alwaysAllow rule covers the call, and none does: every call to it is refused. Add { type: alwaysAllow, pattern: WebFetch } to permissions.rules, or remove the tool",
      },
    ]);
  });

  test("a safety setting the worker does not enforce is refused, naming its path", () => {
    let thrown: unknown;
    try {
      emitCfWorkerBundle(...ir(`${CLI_SPEC}budget: { usd: 1 }\n`));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CompilerError);
    expect((thrown as Error).message).toContain(
      "  budget: a Cloudflare Worker keeps no spend meter",
    );
  });

  test("threads allowedOrigins into the emitted worker", () => {
    const bundle = emitCfWorkerBundle(...ir(CLI_SPEC), {
      allowedOrigins: ["https://example.test"],
    });
    const worker = bundle.files.find((f) => f.path === "worker.js");
    expect(worker?.content).toContain("https://example.test");
  });

  test("unsupported target (channel) throws CompilerError naming the supported set", () => {
    let thrown: unknown;
    try {
      emitCfWorkerBundle(...ir(CHANNEL_SPEC));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CompilerError);
    expect((thrown as Error).message).toContain("cf-worker emit supports target=");
    expect((thrown as Error).message).toContain("got channel");
    // The message lists exactly cli|workflow|graph.
    expect((thrown as Error).message).toContain(CF_WORKER_EMIT_TARGETS.join("|"));
  });

  test("an unsupported target is reported before its tools are checked", () => {
    // The channel starter's tools (read, bash) are host tools the edge
    // refuses; the operator must hear about the target first, since fixing
    // the tools would only lead to this error.
    const spec = CHANNEL_SPEC.replace(
      "agent:\n",
      "agent:\n  tools: [read, bash, mcp__evil__send]\n",
    );
    expect(spec).toContain("tools: [read, bash, mcp__evil__send]");
    expect(() => emitCfWorkerBundle(...ir(spec))).toThrow(
      /^cf-worker emit supports target=cli\|workflow\|graph, got channel$/,
    );
  });

  test("CF_WORKER_EMIT_TARGETS is the cli/workflow/graph set", () => {
    expect([...CF_WORKER_EMIT_TARGETS]).toEqual(["cli", "workflow", "graph"]);
  });
});
