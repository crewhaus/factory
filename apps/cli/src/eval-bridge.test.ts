import { describe, expect, test } from "bun:test";
import { lower } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import { EvalBridgeError, describeBridge, projectEvalIr, selectInvoker } from "./eval-bridge";

/** Lower an inline spec to its IR node (the pure input `projectEvalIr` takes). */
function ir(yaml: string): ReturnType<typeof lower> {
  return lower(parseSpec(yaml));
}

const CHANNEL_YAML = `
name: support-bot
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    Answer support questions briefly.
  tools:
    - webSearch
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
`;

const VOICE_YAML = `
name: phone-agent
target: voice
agent:
  model: claude-sonnet-4-6
  instructions: |
    Be brief on the phone.
voice:
  provider: openai
`;

const MANAGED_YAML = `
name: gateway-agent
target: managed
agent:
  model: claude-sonnet-4-6
  instructions: |
    Managed daemon agent.
tenants:
  - id: t1
    budget:
      maxInputTokens: 100000
      maxOutputTokens: 20000
`;

const CLI_YAML = `
name: cli-agent
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: Do the thing.
`;

const EVAL_YAML = `
name: an-eval
target: eval
agent:
  model: claude-sonnet-4-6
  instructions: Answer briefly.
dataset:
  name: an-eval
  version: v1
  split: dev
graders:
  - name: exact_match
concurrency: 2
`;

const WORKFLOW_YAML = `
name: a-flow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: one
    instructions: step one
  - name: two
    instructions: step two
`;

describe("projectEvalIr (#10)", () => {
  test("projects a channel-bot IR into a target: eval IR reusing the same agent", () => {
    const projected = projectEvalIr(ir(CHANNEL_YAML));
    expect(projected.target).toBe("eval");
    expect(projected.name).toBe("support-bot");
    expect(projected.agent.model).toBe("claude-sonnet-4-6");
    expect(projected.agent.instructions).toContain("support questions");
    // The channel bot's tool list is carried into the eval agent verbatim.
    expect(projected.agent.tools).toContain("webSearch");
    // Default dataset convention: <specName>-eval @ v1 # dev.
    expect(projected.dataset).toEqual({ name: "support-bot-eval", version: "v1", split: "dev" });
    // Cluster S — the default grader is the REAL deterministic built-in
    // (the former `substring_match` default was not a valid grader type, so
    // default bridged bundles failed grader parsing at boot).
    expect(projected.graders.map((g) => g.name)).toEqual(["expected_contains"]);
    expect(projected.concurrency).toBe(2);
  });

  test("projects a voice IR (agent with no explicit tools) with an empty tool list", () => {
    const projected = projectEvalIr(ir(VOICE_YAML));
    expect(projected.name).toBe("phone-agent");
    expect(projected.agent.tools).toEqual([]);
    expect(projected.dataset.name).toBe("phone-agent-eval");
  });

  test("projects a managed IR", () => {
    const projected = projectEvalIr(ir(MANAGED_YAML));
    expect(projected.target).toBe("eval");
    expect(projected.agent.instructions).toContain("Managed daemon");
  });

  test("honors dataset + grader + concurrency + seed overrides", () => {
    const projected = projectEvalIr(ir(CHANNEL_YAML), {
      datasetName: "support-ratings",
      datasetVersion: "v3",
      datasetSplit: "test",
      graders: [{ name: "llm_judge", opts: { rubric: "helpful" } }],
      concurrency: 8,
      seed: 42,
    });
    expect(projected.dataset).toEqual({ name: "support-ratings", version: "v3", split: "test" });
    expect(projected.graders).toEqual([{ name: "llm_judge", opts: { rubric: "helpful" } }]);
    expect(projected.concurrency).toBe(8);
    expect(projected.seed).toBe(42);
  });

  test("rejects a cli spec (use eval directly)", () => {
    expect(() => projectEvalIr(ir(CLI_YAML))).toThrow(EvalBridgeError);
    expect(() => projectEvalIr(ir(CLI_YAML))).toThrow(/target: cli/);
  });

  test("rejects a spec that is already target: eval", () => {
    expect(() => projectEvalIr(ir(EVAL_YAML))).toThrow(/already target: eval/);
  });
});

// Evals Wave 4, cluster S (D36 + NEW-shape-1) — the multi-stage rejection is
// LIFTED: workflow/graph/crew/pipeline project into runtime-invoking bridges.
describe("projectEvalIr — multi-stage shapes (cluster S)", () => {
  const GRAPH_YAML = `
name: a-graph
target: graph
model: claude-sonnet-4-6
entry: plan
nodes:
  plan:
    instructions: plan it
    model: graph-entry-model
  act:
    instructions: act on it
edges:
  - from: plan
    to: act
`;
  const CREW_YAML = `
name: a-crew
target: crew
model: claude-sonnet-4-6
entry: lead
roles:
  lead:
    instructions: lead it
`;
  const PIPELINE_YAML = `
name: a-rag
target: pipeline
agent:
  model: claude-sonnet-4-6
  instructions: answer using Retrieve
retrieve:
  embedderModel: mock/det
  vectorBackend: in-memory
indexing:
  chunkStrategy: fixed
  chunkSize: 200
  chunkOverlap: 0
  documents:
    - id: doc-1
      text: the quick brown fox
`;

  test("workflow projects a bridge-descriptor agent (entry step's model)", () => {
    const projected = projectEvalIr(ir(WORKFLOW_YAML));
    expect(projected.target).toBe("eval");
    expect(projected.name).toBe("a-flow");
    expect(projected.agent.model).toBe("claude-sonnet-4-6");
    expect(projected.agent.instructions).toContain("[eval bridge] multi-stage workflow");
    expect(projected.agent.instructions).toContain("never used as a chat prompt");
    expect(projected.agent.tools).toEqual([]);
    expect(projected.dataset).toEqual({ name: "a-flow-eval", version: "v1", split: "dev" });
  });

  test("graph projects the ENTRY node's model", () => {
    const projected = projectEvalIr(ir(GRAPH_YAML));
    expect(projected.agent.model).toBe("graph-entry-model");
    expect(projected.agent.instructions).toContain("multi-stage graph");
  });

  test("crew projects the entry role's model", () => {
    const projected = projectEvalIr(ir(CREW_YAML));
    expect(projected.agent.model).toBe("claude-sonnet-4-6");
    expect(projected.agent.instructions).toContain("multi-stage crew");
  });

  test("pipeline keeps its REAL chat agent (the runtime IS the agent + Retrieve)", () => {
    const projected = projectEvalIr(ir(PIPELINE_YAML));
    expect(projected.agent.model).toBe("claude-sonnet-4-6");
    expect(projected.agent.instructions).toBe("answer using Retrieve");
  });

  test("the source spec's failure_taxonomy rides the projection (D37)", () => {
    const yaml = `${WORKFLOW_YAML}failure_taxonomy:
  - class: rate_limited
    pattern: /429/
    recovery: retry
`;
    const projected = projectEvalIr(ir(yaml));
    expect(projected.failureTaxonomy?.[0]?.class).toBe("rate_limited");
  });
});

describe("selectInvoker (#10 + cluster S)", () => {
  test("channel → channel-resume-turn, runtime-invoking + chat-capable", () => {
    const s = selectInvoker("channel");
    expect(s.kind).toBe("channel-resume-turn");
    expect(s.entryImport).toBe("../eval-entry.ts");
    expect(s.chatCapable).toBe(true);
  });
  test("voice → voice-replay (documented; chat-capable)", () => {
    const s = selectInvoker("voice");
    expect(s.kind).toBe("voice-replay");
    expect(s.entryImport).toBeUndefined();
    expect(s.chatCapable).toBe(true);
  });
  test("managed → gateway-request driving runOneTurn", () => {
    const s = selectInvoker("managed");
    expect(s.kind).toBe("gateway-request");
    expect(s.entryImport).toBe("../agent.ts");
    expect(s.chatCapable).toBe(true);
  });
  test("workflow/graph → runtime entries in ../agent.ts, non-chat", () => {
    for (const [target, kind] of [
      ["workflow", "workflow-run"],
      ["graph", "graph-run"],
    ] as const) {
      const s = selectInvoker(target);
      expect(s.kind).toBe(kind);
      expect(s.entryImport).toBe("../agent.ts");
      expect(s.chatCapable).toBe(false);
    }
  });
  test("crew → crew-run via ../eval-entry.ts, non-chat", () => {
    const s = selectInvoker("crew");
    expect(s.kind).toBe("crew-run");
    expect(s.entryImport).toBe("../eval-entry.ts");
    expect(s.chatCapable).toBe(false);
  });
  test("pipeline → pipeline-query via ../agent.ts, chat-capable", () => {
    const s = selectInvoker("pipeline");
    expect(s.kind).toBe("pipeline-query");
    expect(s.entryImport).toBe("../agent.ts");
    expect(s.chatCapable).toBe(true);
  });
  test("onchain + onchain-game → chain-trigger (documented, non-chat)", () => {
    expect(selectInvoker("onchain").kind).toBe("chain-trigger");
    expect(selectInvoker("onchain-game").kind).toBe("chain-trigger");
    expect(selectInvoker("onchain").chatCapable).toBe(false);
    expect(selectInvoker("onchain").entryImport).toBeUndefined();
  });
  test("batch → batch-item (documented, non-chat)", () => {
    const s = selectInvoker("batch");
    expect(s.kind).toBe("batch-item");
    expect(s.chatCapable).toBe(false);
  });
  test("unknown/browser → single-turn-chat-loop default (real wired tools)", () => {
    const s = selectInvoker("browser");
    expect(s.kind).toBe("single-turn-chat-loop");
    expect(s.chatCapable).toBe(false);
    expect(s.description).toContain("real wired tools");
  });
});

describe("describeBridge (#10 + cluster S)", () => {
  test("renders a one-line summary naming the dataset + invoker + history posture", () => {
    const projected = projectEvalIr(ir(CHANNEL_YAML));
    const line = describeBridge(projected, selectInvoker("channel"));
    expect(line).toContain("eval bridge for target: channel");
    expect(line).toContain("support-bot-eval@v1#dev");
    expect(line).toContain("channel-resume-turn");
    expect(line).toContain("history samples: seeded");
  });

  test("entry-driven non-chat shapes advertise the history rejection", () => {
    const projected = projectEvalIr(ir(WORKFLOW_YAML));
    const line = describeBridge(projected, selectInvoker("workflow"));
    expect(line).toContain("workflow-run");
    expect(line).toContain("history samples: rejected (single-trigger runtime)");
  });

  test("entry-LESS bridges advertise the default invoker's native history seeding", () => {
    // research/browser/onchain/batch run the eval-runner's own single-turn
    // chat loop, which seeds history (B14) — the line must not claim rejection.
    const projected = projectEvalIr(ir(WORKFLOW_YAML));
    const line = describeBridge(projected, selectInvoker("onchain"));
    expect(line).toContain("history samples: seeded by the default single-turn invoker");
    expect(line).not.toContain("rejected");
  });
});

// The recorded `specHash` (eval-runner hashes {name,target,model,instructions,
// tools}) must move when the DRIVEN runtime moves — otherwise bridged
// multi-stage baselines and cluster R's `--resume` guard cannot tell two
// materially different workflows apart.
describe("projectEvalIr — multi-stage run identity tracks the driven stages", () => {
  const flow = (oneInstructions: string, twoInstructions: string, model = "claude-sonnet-4-6") => `
name: a-flow
target: workflow
model: ${model}
steps:
  - name: one
    instructions: ${oneInstructions}
  - name: two
    instructions: ${twoInstructions}
`;
  /** The exact tuple eval-runner's hashSpec digests. */
  const hashInput = (yaml: string) => {
    const p = projectEvalIr(ir(yaml));
    return JSON.stringify({
      name: p.name,
      target: p.target,
      model: p.agent.model,
      instructions: p.agent.instructions,
      tools: p.agent.tools,
    });
  };

  test("editing a step's instructions changes the projected hash input", () => {
    expect(hashInput(flow("step one", "step two"))).not.toBe(
      hashInput(flow("step one", "step two REWRITTEN")),
    );
  });

  test("editing BOTH steps' instructions changes it (the stage count is unchanged)", () => {
    expect(hashInput(flow("step one", "step two"))).not.toBe(hashInput(flow("A", "B")));
  });

  test("an identical spec projects an identical hash input (deterministic)", () => {
    expect(hashInput(flow("step one", "step two"))).toBe(hashInput(flow("step one", "step two")));
  });

  test("a per-stage tool change is covered too", () => {
    const withTool = `
name: a-flow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: one
    instructions: step one
    tools:
      - read
  - name: two
    instructions: step two
`;
    expect(hashInput(flow("step one", "step two"))).not.toBe(hashInput(withTool));
  });
});
