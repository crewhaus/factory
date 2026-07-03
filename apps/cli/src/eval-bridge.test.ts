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
    expect(projected.graders.map((g) => g.name)).toEqual(["substring_match"]);
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

  test("rejects a multi-stage shape with a clear diagnostic", () => {
    let msg = "";
    try {
      projectEvalIr(ir(WORKFLOW_YAML));
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("multi-stage");
    expect(msg).toContain("steps");
  });
});

describe("selectInvoker (#10)", () => {
  test("channel → channel-resume-turn", () => {
    expect(selectInvoker("channel").kind).toBe("channel-resume-turn");
  });
  test("voice → voice-replay", () => {
    expect(selectInvoker("voice").kind).toBe("voice-replay");
  });
  test("managed → gateway-request", () => {
    expect(selectInvoker("managed").kind).toBe("gateway-request");
  });
  test("onchain + onchain-game → chain-trigger", () => {
    expect(selectInvoker("onchain").kind).toBe("chain-trigger");
    expect(selectInvoker("onchain-game").kind).toBe("chain-trigger");
  });
  test("batch → batch-item", () => {
    expect(selectInvoker("batch").kind).toBe("batch-item");
  });
  test("unknown/browser → single-turn-chat-loop default", () => {
    expect(selectInvoker("browser").kind).toBe("single-turn-chat-loop");
  });
});

describe("describeBridge (#10)", () => {
  test("renders a one-line summary naming the dataset + invoker", () => {
    const projected = projectEvalIr(ir(CHANNEL_YAML));
    const line = describeBridge(projected, selectInvoker("channel"));
    expect(line).toContain("eval bridge for target: channel");
    expect(line).toContain("support-bot-eval@v1#dev");
    expect(line).toContain("channel-resume-turn");
  });
});
