/**
 * #394 (the half hiding inside it) — `transport: "sse"` must reach BOTH HTTP
 * MCP revisions.
 *
 * MCP has two HTTP transports: the 2024-11-05 revision's HTTP+SSE (open with
 * `GET` → `text/event-stream`, receive an `endpoint` event) and the
 * 2025-03-26 revision's Streamable HTTP (POST JSON-RPC to one URL). Our own
 * two halves disagreed: `@crewhaus/mcp-server` serves Streamable HTTP while
 * this client spoke only legacy SSE — so a CrewHaus daemon exposed over
 * `expose.mcp.transport: sse` could not be consumed by a CrewHaus peer
 * declaring `mcp_servers: { peer: { transport: sse } }`. The legacy client's
 * opening GET got `400 application/json`, which surfaced to operators as
 * `SSE error: Invalid content type`.
 *
 * These drive REAL servers over loopback — a fake transport would prove
 * nothing about wire compatibility, which is the entire subject.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { McpClient, httpTransportCandidates } from "./client";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
const clients: McpClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect().catch(() => {});
  for (const s of servers.splice(0)) s.stop(true);
});

/**
 * A real Streamable HTTP MCP server on a kernel-assigned port, built from the
 * SDK directly.
 *
 * Deliberately NOT `@crewhaus/mcp-server`: this package must not depend on
 * it (the dependency would be new, and only for a test), and the subject here
 * is the WIRE PROTOCOL, not our wrapper. Same transport class our own
 * projection uses, so a client that talks to this talks to that.
 */
function streamableServer(): { url: string } {
  const server = new McpServer({ name: "probe-target", version: "0.0.0" });
  server.tool("chat", { message: z.string() }, async ({ message }) => ({
    content: [{ type: "text" as const, text: `echo:${message}` }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  void server.connect(transport);
  const http = Bun.serve({ port: 0, fetch: (req) => transport.handleRequest(req) });
  servers.push(http);
  return { url: `http://127.0.0.1:${http.port}/mcp` };
}

describe("the HTTP wire candidates", () => {
  test("Streamable HTTP is tried FIRST, legacy HTTP+SSE second", () => {
    // Order is the contract: Streamable HTTP is the current revision and the
    // one our own emit serves; legacy is the fallback that keeps a
    // third-party 2024-11-05 server — the reason this config value existed —
    // working unchanged.
    const wires = httpTransportCandidates({
      transport: "sse",
      url: "http://127.0.0.1:1/mcp",
    }).map((c) => c.wire);
    expect(wires).toEqual(["streamable-http", "http-sse"]);
  });
});

describe("connecting to our OWN exposed server", () => {
  test("a `transport: sse` client completes the handshake and lists tools", async () => {
    // The regression pin: against today's pre-fix client this throws
    // `SSE error: Non-200 status code (400)`.
    const { url } = streamableServer();
    const client = new McpClient("peer", { transport: "sse", url }, { connectTimeoutMs: 10_000 });
    clients.push(client);
    await client.connect();
    expect((await client.listTools()).map((t) => t.name)).toEqual(["chat"]);
  }, 20_000);

  test("a tool call round-trips through the negotiated transport", async () => {
    const { url } = streamableServer();
    const client = new McpClient("peer", { transport: "sse", url }, { connectTimeoutMs: 10_000 });
    clients.push(client);
    await client.connect();
    const result = await client.callTool("chat", { message: "ping" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("echo:ping");
  }, 20_000);

  test("the legacy opening GET is REFUSED by that server — the mismatch is real", async () => {
    // Pins the actual incompatibility rather than trusting the docblock: if
    // this ever answers 200 text/event-stream, the server grew legacy support
    // and the probe's ordering rationale needs revisiting.
    const { url } = streamableServer();
    const res = await fetch(url, { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  }, 20_000);
});

describe("the probe does not change the other paths", () => {
  test("an injected transportFactory is honoured verbatim and never probed", async () => {
    // The test seam AND the escape hatch: probing past it would build the
    // caller's transport twice.
    let built = 0;
    const client = new McpClient(
      "peer",
      { transport: "sse", url: "http://127.0.0.1:1/mcp" },
      {
        connectTimeoutMs: 500,
        transportFactory: () => {
          built += 1;
          return {
            start: async () => {
              throw new Error("nope");
            },
            send: async () => {},
            close: async () => {},
          } as unknown as ReturnType<
            typeof httpTransportCandidates
          >[number]["build"] extends () => infer T
            ? T
            : never;
        },
      },
    );
    clients.push(client);
    await expect(client.connect()).rejects.toThrow();
    expect(built).toBe(1);
  }, 20_000);

  test("an unreachable peer still fails with the connect error, not a probe artefact", async () => {
    const client = new McpClient(
      "peer",
      { transport: "sse", url: "http://127.0.0.1:1/mcp" },
      { connectTimeoutMs: 2_000 },
    );
    clients.push(client);
    await expect(client.connect()).rejects.toThrow(/mcp connect to "peer" failed|timed out/);
  }, 20_000);
});
