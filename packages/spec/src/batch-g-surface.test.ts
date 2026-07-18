/**
 * Batch G — parse-level tests for the five spec surfaces this keystone owns:
 *   - Item 1 (G30): the `expose:` block (MCP-server projection) on
 *     cli/channel/managed, plus the `per-subagent` cross-field invariant.
 *   - Item 3 (G32): the `plugins:` list on cli/channel.
 *   - Item 5 (G44): `thredz.messaging` (default-off, object form only).
 *   - Item 2 (G31): `sub_agents.<name>.federation.url`.
 *   - Item 9 (G37): `model_pool`/`model_tiers`/`model_fallbacks` on workflow
 *     steps + crew roles (reusing the cli agent block's mutual-exclusion rule).
 *
 * The spec layer carries declared fields VERBATIM (defaults such as
 * `expose.mcp.tools` and `thredz.messaging` resolve in the compiler lowering);
 * these tests assert acceptance/rejection + the on-declaration shape.
 */
import { describe, expect, test } from "bun:test";
import { SpecParseError, parseSpec } from "./index";

const cliWith = (block: string): string =>
  ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", block].join("\n");

const channelWith = (block: string): string =>
  [
    "name: c",
    "target: channel",
    "agent:",
    "  model: m",
    "  instructions: i",
    "channels:",
    "  slack:",
    "    botToken: $SLACK_BOT_TOKEN",
    "    signingSecret: $SLACK_SIGNING_SECRET",
    "routing:",
    "  sessionKey: thread",
    block,
  ].join("\n");

const managedWith = (block: string): string =>
  [
    "name: m",
    "target: managed",
    "agent:",
    "  model: m",
    "  instructions: i",
    "tenants:",
    "  - id: t1",
    "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
    block,
  ].join("\n");

describe("Item 1 (G30) — expose:", () => {
  test("accepts expose.mcp with stdio transport on cli", () => {
    const spec = parseSpec(cliWith("expose:\n  mcp:\n    transport: stdio"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.expose?.mcp?.transport).toBe("stdio");
    expect(spec.expose?.mcp?.tools).toBeUndefined();
  });

  test("accepts sse transport + tools chat/per-subagent on channel", () => {
    const spec = parseSpec(channelWith("expose:\n  mcp:\n    transport: sse\n    tools: chat"));
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.expose?.mcp).toEqual({ transport: "sse", tools: "chat" });
  });

  test("accepts expose on managed (SSE endpoint riding gateway tenancy)", () => {
    const spec = parseSpec(managedWith("expose:\n  mcp:\n    transport: sse"));
    if (spec.target !== "managed") throw new Error("unexpected target");
    expect(spec.expose?.mcp?.transport).toBe("sse");
  });

  test("is optional — omitting leaves expose undefined", () => {
    const spec = parseSpec(cliWith("permissions:\n  mode: auto"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.expose).toBeUndefined();
  });

  test("rejects an unknown transport", () => {
    expect(() => parseSpec(cliWith("expose:\n  mcp:\n    transport: grpc"))).toThrow(
      SpecParseError,
    );
  });

  test("rejects an unknown tools value", () => {
    expect(() =>
      parseSpec(cliWith("expose:\n  mcp:\n    transport: stdio\n    tools: everything")),
    ).toThrow(SpecParseError);
  });

  test("rejects a stray key inside expose.mcp (strict)", () => {
    expect(() =>
      parseSpec(cliWith("expose:\n  mcp:\n    transport: stdio\n    port: 9000")),
    ).toThrow(SpecParseError);
  });

  test("rejects expose: on a non-serving shape (workflow strict union)", () => {
    expect(() =>
      parseSpec(
        [
          "name: w",
          "target: workflow",
          "model: m",
          "steps:",
          "  - name: a",
          "    instructions: ai",
          "expose:",
          "  mcp:",
          "    transport: stdio",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  describe("per-subagent cross-field invariant", () => {
    test("accepts per-subagent when the cli agent declares a sub_agent", () => {
      const spec = parseSpec(
        cliWith(
          [
            "  sub_agents:",
            "    helper:",
            "      description: helps",
            "      instructions: help",
            "expose:",
            "  mcp:",
            "    transport: stdio",
            "    tools: per-subagent",
          ].join("\n"),
        ),
      );
      if (spec.target !== "cli") throw new Error("unexpected target");
      expect(spec.expose?.mcp?.tools).toBe("per-subagent");
    });

    test("rejects per-subagent when the cli shape declares no sub_agents", () => {
      expect(() =>
        parseSpec(cliWith("expose:\n  mcp:\n    transport: stdio\n    tools: per-subagent")),
      ).toThrow(/per-subagent.*no sub_agents/);
    });

    test("rejects per-subagent on managed (no sub_agents surface at all)", () => {
      expect(() =>
        parseSpec(managedWith("expose:\n  mcp:\n    transport: sse\n    tools: per-subagent")),
      ).toThrow(/per-subagent.*no sub_agents/);
    });

    test("chat (the default kind) needs no sub_agents", () => {
      const spec = parseSpec(cliWith("expose:\n  mcp:\n    transport: stdio\n    tools: chat"));
      if (spec.target !== "cli") throw new Error("unexpected target");
      expect(spec.expose?.mcp?.tools).toBe("chat");
    });
  });
});

describe("Item 3 (G32) — plugins:", () => {
  test("accepts a list of plugin names on cli (order preserved)", () => {
    const spec = parseSpec(cliWith("plugins:\n  - acme-tools\n  - reporter"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.plugins).toEqual(["acme-tools", "reporter"]);
  });

  test("accepts plugins on channel", () => {
    const spec = parseSpec(channelWith("plugins:\n  - acme-tools"));
    if (spec.target !== "channel") throw new Error("unexpected target");
    expect(spec.plugins).toEqual(["acme-tools"]);
  });

  test("is optional — omitting leaves plugins undefined", () => {
    const spec = parseSpec(cliWith("permissions:\n  mode: auto"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.plugins).toBeUndefined();
  });

  test("rejects a non-string entry", () => {
    expect(() => parseSpec(cliWith("plugins:\n  - 42"))).toThrow(SpecParseError);
  });

  test("rejects an empty-string entry", () => {
    expect(() => parseSpec(cliWith('plugins:\n  - ""'))).toThrow(SpecParseError);
  });

  test("rejects plugins: on managed (item 3 scopes it to cli + channel)", () => {
    expect(() => parseSpec(managedWith("plugins:\n  - acme-tools"))).toThrow(SpecParseError);
  });
});

describe("Item 5 (G44) — thredz.messaging", () => {
  test("accepts messaging: true on the object form", () => {
    const spec = parseSpec(cliWith("thredz:\n  api_key: $THREDZ_API_KEY\n  messaging: true"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    if (typeof spec.thredz !== "object") throw new Error("expected object thredz");
    expect(spec.thredz.messaging).toBe(true);
  });

  test("accepts messaging: false explicitly", () => {
    const spec = parseSpec(cliWith("thredz:\n  api_key: $THREDZ_API_KEY\n  messaging: false"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    if (typeof spec.thredz !== "object") throw new Error("expected object thredz");
    expect(spec.thredz.messaging).toBe(false);
  });

  test("is optional — the object form without messaging leaves it undefined", () => {
    const spec = parseSpec(cliWith("thredz:\n  api_key: $THREDZ_API_KEY"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    if (typeof spec.thredz !== "object") throw new Error("expected object thredz");
    expect(spec.thredz.messaging).toBeUndefined();
  });

  test("rejects a non-boolean messaging value", () => {
    expect(() =>
      parseSpec(cliWith("thredz:\n  api_key: $THREDZ_API_KEY\n  messaging: yes-please")),
    ).toThrow(SpecParseError);
  });
});

describe("Item 2 (G31) — sub_agents.<name>.federation", () => {
  const withSub = (fed: string): string =>
    cliWith(
      [
        "  sub_agents:",
        "    peer:",
        "      description: a remote peer",
        "      instructions: delegate",
        fed,
      ].join("\n"),
    );

  test("accepts federation.url on a sub-agent", () => {
    const spec = parseSpec(withSub("      federation:\n        url: https://peer.example.com"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.agent.sub_agents?.peer?.federation?.url).toBe("https://peer.example.com");
  });

  test("is optional — a local sub-agent omits federation", () => {
    const spec = parseSpec(withSub("      model: claude-haiku-4-5"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.agent.sub_agents?.peer?.federation).toBeUndefined();
  });

  test("rejects a non-URL federation.url", () => {
    expect(() => parseSpec(withSub("      federation:\n        url: not a url"))).toThrow(
      SpecParseError,
    );
  });

  test("rejects a stray key inside federation (strict)", () => {
    expect(() =>
      parseSpec(
        withSub("      federation:\n        url: https://peer.example.com\n        token: t"),
      ),
    ).toThrow(SpecParseError);
  });
});

describe("Item 9 (G37) — model routing on workflow steps + crew roles", () => {
  const workflowStep = (stepBody: string): string =>
    ["name: w", "target: workflow", "model: m", "steps:", "  - name: s", stepBody].join("\n");

  const crewRole = (roleBody: string): string =>
    ["name: cr", "target: crew", "model: m", "entry: lead", "roles:", "  lead:", roleBody].join(
      "\n",
    );

  test("workflow step accepts a model_pool", () => {
    const spec = parseSpec(
      workflowStep(
        [
          "    instructions: do it",
          "    model_pool:",
          "      candidates:",
          "        - model: claude-haiku-4-5",
          "          tags: [cheap]",
          "        - model: claude-opus-4-8",
          "          tags: [strong]",
          "      policy: heuristic",
        ].join("\n"),
      ),
    );
    if (spec.target !== "workflow") throw new Error("unexpected target");
    const step = spec.steps[0];
    if (step === undefined || "kind" in step) throw new Error("expected a regular step");
    expect(step.model_pool?.candidates.length).toBe(2);
    expect(step.model_pool?.policy).toBe("heuristic");
  });

  test("workflow step accepts model_fallbacks + circuit_breaker", () => {
    const spec = parseSpec(
      workflowStep(
        [
          "    instructions: do it",
          "    model_fallbacks: [claude-haiku-4-5]",
          "    circuit_breaker:",
          "      failureThreshold: 3",
        ].join("\n"),
      ),
    );
    if (spec.target !== "workflow") throw new Error("unexpected target");
    const step = spec.steps[0];
    if (step === undefined || "kind" in step) throw new Error("expected a regular step");
    expect(step.model_fallbacks).toEqual(["claude-haiku-4-5"]);
    expect(step.circuit_breaker?.failureThreshold).toBe(3);
  });

  test("crew role accepts model_tiers", () => {
    const spec = parseSpec(
      crewRole(
        [
          "    instructions: lead it",
          "    model_tiers:",
          "      fast: claude-haiku-4-5",
          "      default: claude-opus-4-8",
        ].join("\n"),
      ),
    );
    if (spec.target !== "crew") throw new Error("unexpected target");
    expect(spec.roles.lead?.model_tiers).toEqual({
      fast: "claude-haiku-4-5",
      default: "claude-opus-4-8",
    });
  });

  test("workflow step enforces the pool/tiers mutual exclusion", () => {
    expect(() =>
      parseSpec(
        workflowStep(
          [
            "    instructions: do it",
            "    model_tiers:",
            "      fast: claude-haiku-4-5",
            "      default: claude-opus-4-8",
            "    model_pool:",
            "      candidates:",
            "        - model: a",
            "          tags: []",
            "        - model: b",
            "          tags: []",
            "      policy: heuristic",
          ].join("\n"),
        ),
      ),
    ).toThrow(/mutually exclusive/);
  });

  test("crew role enforces the pool/fallbacks mutual exclusion", () => {
    expect(() =>
      parseSpec(
        crewRole(
          [
            "    instructions: lead it",
            "    model_fallbacks: [claude-haiku-4-5]",
            "    model_pool:",
            "      candidates:",
            "        - model: a",
            "          tags: []",
            "        - model: b",
            "          tags: []",
            "      policy: heuristic",
          ].join("\n"),
        ),
      ),
    ).toThrow(/mutually exclusive/);
  });

  test("a judge step rejects model_pool (gate steps run no agent turn)", () => {
    expect(() =>
      parseSpec(
        [
          "name: w",
          "target: workflow",
          "model: m",
          "steps:",
          "  - name: s1",
          "    instructions: draft",
          "  - name: gate",
          "    kind: judge",
          "    judge:",
          "      criteria: good",
          "    model_pool:",
          "      candidates:",
          "        - model: a",
          "          tags: []",
          "        - model: b",
          "          tags: []",
          "      policy: heuristic",
        ].join("\n"),
      ),
    ).toThrow(SpecParseError);
  });

  test("regular workflow steps still reject unknown fields (strict survives superRefine)", () => {
    expect(() =>
      parseSpec(workflowStep(["    instructions: do it", "    bogus: 1"].join("\n"))),
    ).toThrow(SpecParseError);
  });
});
