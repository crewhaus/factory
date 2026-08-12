/**
 * #394 — `expose.mcp.transport: sse` on a channel spec actually EMITS an MCP
 * endpoint.
 *
 * The block was parsed, lowered to `IrExpose`, and read by no emitter, so a
 * channel daemon could not be reached as an MCP tool at all — while
 * `serve --mcp`'s refusal text and the Hangar console both told operators it
 * self-exposed. These pin the emitted wiring, the bearer gate, and the
 * byte-identity of a bundle that does NOT opt in.
 *
 * The live round trip (a real McpClient driving a real mcp-server handle
 * through this route shape) is pinned in `mcp-host`'s transport test; here
 * the subject is the CODEGEN.
 */
import { describe, expect, test } from "bun:test";
import { compile } from "./index";

const SPEC = (extra = ""): string => `name: exposed-bot
target: channel
agent:
  model: anthropic/claude-sonnet-4
  instructions: |
    You are a fixture.
${extra}channels:
  slack:
    signingSecret: $SLACK_SIGNING_SECRET
    botToken: $SLACK_BOT_TOKEN
routing:
  sessionKey: channel
`;

const EXPOSED = SPEC("expose:\n  mcp:\n    transport: sse\n");

function bundleOf(spec: string): Map<string, string> {
  return new Map(compile(spec, { readme: false }).files.map((f) => [f.path, f.content]));
}

describe("expose.mcp: sse — the emitted mount", () => {
  const files = bundleOf(EXPOSED);
  const gateway = files.get("gateway.ts") ?? "";
  const daemon = files.get("daemon.ts") ?? "";

  test("the gateway serves /mcp, ahead of the adapter routes", () => {
    expect(gateway).toContain('url.pathname === "/mcp"');
    // Ahead of the `/<adapter>/events` match, or an adapter named "mcp"
    // would shadow it.
    expect(gateway.indexOf('url.pathname === "/mcp"')).toBeLessThan(gateway.indexOf("events$"));
  });

  test("the daemon builds the server over its OWN turn function", () => {
    expect(daemon).toContain('import { createMcpServer } from "@crewhaus/mcp-server"');
    expect(daemon).toContain("createMcpServer({");
    // The MCP `chat` tool must reach the same loop a channel message does —
    // memory fabric, boundary classifier, permissions and all.
    expect(daemon).toContain("agent.runTurn({");
  });

  test("boot NAMES the endpoint and the token source (#394 asks for the URL)", () => {
    expect(daemon).toContain("[mcp] serving this agent at http://localhost:");
    expect(daemon).toContain("/mcp");
    expect(daemon).toContain("[mcp] bearer:");
  });

  test("the server is closed on shutdown, like every other bound resource", () => {
    expect(daemon).toContain("__mcpServer.close()");
  });

  test("each MCP caller gets its own session — never a fresh one per call", () => {
    // A fresh session per call would make every MCP turn amnesiac; one shared
    // session for all callers would cross-contaminate transcripts.
    expect(daemon).toContain("__mcpSessions");
    expect(daemon).toContain("isNew: __existing === undefined");
  });
});

describe("expose.mcp: sse — the bearer gate", () => {
  const files = bundleOf(EXPOSED);
  const gateway = files.get("gateway.ts") ?? "";
  const daemon = files.get("daemon.ts") ?? "";

  test("the route is authenticated — this is the UNAUTHENTICATED public port", () => {
    // The adapter routes are signature-verified per platform and /healthz is
    // deliberately public, but MCP drives whole agent turns with this
    // bundle's tools and credentials. Serving that open would hand the agent
    // to anyone who can reach the port.
    expect(gateway).toContain("config.mcpAuthorize");
    expect(gateway).toContain("status: 401");
    expect(gateway).toContain("Bearer ");
  });

  test("the token follows the control.v1 contract: env, else minted 0600 at boot", () => {
    expect(daemon).toContain('process.env["CREWHAUS_MCP_TOKEN"]');
    expect(daemon).toContain("mcp-token");
    expect(daemon).toContain("0o600");
    // Minted FRESH each boot — a token left by a dead daemon must not
    // authenticate against its replacement.
    expect(daemon).toContain("randomBytes(32)");
  });

  test("the compare is length-independent, so a wrong token leaks no timing", () => {
    expect(daemon).toContain("timingSafeEqual");
    expect(daemon).toContain("__a.length === __b.length");
  });
});

describe("expose.mcp — what is NOT emitted", () => {
  test("a spec without `expose` is byte-identical to one compiled before this feature", () => {
    const plain = bundleOf(SPEC());
    for (const [path, content] of plain) {
      expect(`${path}:${content.includes("createMcpServer")}`).toBe(`${path}:false`);
      expect(`${path}:${content.includes("mcpAuthorize")}`).toBe(`${path}:false`);
      expect(`${path}:${content.includes("CREWHAUS_MCP_TOKEN")}`).toBe(`${path}:false`);
    }
  });

  test("`transport: stdio` mounts nothing — stdio is the `serve --mcp` projection", () => {
    const files = bundleOf(SPEC("expose:\n  mcp:\n    transport: stdio\n"));
    expect(files.get("gateway.ts") ?? "").not.toContain('url.pathname === "/mcp"');
    expect(files.get("daemon.ts") ?? "").not.toContain("createMcpServer");
  });

  test("`per-subagent` projects `chat` — the channel turn takes no routing arg", () => {
    const spec = `name: exposed-bot
target: channel
agent:
  model: anthropic/claude-sonnet-4
  instructions: |
    You are a fixture.
  sub_agents:
    researcher:
      description: does research
      instructions: research things
expose:
  mcp:
    transport: sse
    tools: per-subagent
channels:
  slack:
    signingSecret: $SLACK_SIGNING_SECRET
    botToken: $SLACK_BOT_TOKEN
routing:
  sessionKey: channel
`;
    const daemon = bundleOf(spec).get("daemon.ts") ?? "";
    // Scoped to the createMcpServer call — `subAgents:` legitimately appears
    // elsewhere in the daemon for the Task tool's own sub-agent map.
    const call = daemon.slice(daemon.indexOf("createMcpServer({"));
    const mcpBlock = call.slice(0, call.indexOf("\n  });"));
    expect(mcpBlock).toContain('tools: "chat"');
    // Advertising one tool per sub-agent when none of them can route would be
    // worse than advertising one honest tool.
    expect(mcpBlock).not.toContain("subAgents:");
    // …and the sub-agents themselves still work inside the turn.
    expect(daemon).toContain("spawnSubAgent");
  });
});
