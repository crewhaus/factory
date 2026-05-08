import { describe, expect, test } from "bun:test";
import type { CrewMailbox } from "@crewhaus/agent-context-isolation";
import { createHandoffTool } from "./index.js";

function makeMailbox(roles: string[]): {
  mailbox: CrewMailbox;
  pending: Array<{ target: string; reason: string; context?: unknown }>;
} {
  const pending: Array<{ target: string; reason: string; context?: unknown }> = [];
  const mailbox: CrewMailbox = {
    knownRoles: roles,
    currentRole: () => roles[0] ?? "",
    currentTraceparent: () => "00-00000000000000000000000000000000-0000000000000000-00",
    requestHandoff: (target, reason, context) => {
      pending.push({ target, reason, context });
    },
    sendA2A: async () => "stub",
  };
  return { mailbox, pending };
}

describe("createHandoffTool", () => {
  test("queues handoff to a valid target role", async () => {
    const { mailbox, pending } = makeMailbox(["researcher", "writer", "critic"]);
    const tool = createHandoffTool({
      from: "researcher",
      targets: ["researcher", "writer", "critic"],
    });

    const result = await tool.execute(
      { target: "writer", reason: "research complete; please write the post" },
      { bridge: { crewMailbox: mailbox } as never },
    );

    expect(result).toContain("Handoff queued");
    expect(result).toContain("researcher → writer");
    expect(pending).toEqual([
      { target: "writer", reason: "research complete; please write the post", context: undefined },
    ]);
  });

  test("threads opaque context payload through", async () => {
    const { mailbox, pending } = makeMailbox(["a", "b"]);
    const tool = createHandoffTool({ from: "a", targets: ["a", "b"] });
    const ctx = { bullets: ["fact-1", "fact-2"] };

    await tool.execute(
      { target: "b", reason: "see context", context: ctx },
      { bridge: { crewMailbox: mailbox } as never },
    );

    expect(pending[0]?.context).toEqual(ctx);
  });

  test("refuses self-handoff", async () => {
    const { mailbox, pending } = makeMailbox(["solo"]);
    const tool = createHandoffTool({ from: "solo", targets: ["solo"] });

    const result = await tool.execute(
      { target: "solo", reason: "loop" },
      { bridge: { crewMailbox: mailbox } as never },
    );

    expect(result).toContain("[Handoff error] cannot hand off to self");
    expect(pending).toHaveLength(0);
  });

  test("refuses unknown target role with helpful list", async () => {
    const { mailbox, pending } = makeMailbox(["alpha", "beta"]);
    const tool = createHandoffTool({ from: "alpha", targets: ["alpha", "beta"] });

    const result = await tool.execute(
      { target: "gamma", reason: "missing role" },
      { bridge: { crewMailbox: mailbox } as never },
    );

    expect(result).toContain('unknown role "gamma"');
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(pending).toHaveLength(0);
  });

  test("returns clean error when no bridge / no mailbox is present", async () => {
    const tool = createHandoffTool({ from: "x", targets: ["x", "y"] });

    const noBridge = await tool.execute({ target: "y", reason: "r" }, {});
    expect(noBridge).toContain("crew mailbox is not available");

    const bridgeNoMailbox = await tool.execute(
      { target: "y", reason: "r" },
      { bridge: {} as never },
    );
    expect(bridgeNoMailbox).toContain("crew mailbox is not available");
  });

  test("flag profile: read-only, not destructive, opted out of output classifier", () => {
    const tool = createHandoffTool({ from: "a", targets: ["a", "b"] });
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
    expect(tool.classifyOutput).toBe(false);
  });
});
