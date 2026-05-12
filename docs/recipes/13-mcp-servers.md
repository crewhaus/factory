---
test:
  spec: examples/mcp-smoke/crewhaus.yaml
  bun_scripts:
    - compile:mcp-smoke
    - run:mcp-smoke
---

# Recipe 13 — MCP Servers

Wire a [Model Context Protocol](https://modelcontextprotocol.io)
server into your spec so its tools become callable by the agent. The
runtime starts the server as a subprocess (or connects to a running
one over SSE), lists its tools at boot, namespaces each as
`<serverName>__<toolName>`, and forwards the JSON Schema verbatim to
the model.

You'd use MCP when:

- You want **tools you didn't write** — a community filesystem
  server, a Postgres tool server, a Slack lookup server.
- You want **language-agnostic tools** — Python tools, Go tools,
  whatever the server author chose.
- You want **out-of-process isolation** — the tool server can crash
  without taking the agent with it (the runtime reconnects).

If your tool is a few lines of TypeScript, just author it locally in
[`tool-builder`](../../packages/tool-builder) — MCP overhead isn't worth
it for trivial cases.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.

## Adding an MCP server

The smallest example, [`examples/mcp-smoke/crewhaus.yaml`](../../examples/mcp-smoke/crewhaus.yaml):

```yaml
name: mcp-smoke
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    Tools prefixed with everything__ come from the reference MCP
    server. Use them when asked.
mcp_servers:
  everything:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-everything"]
```

Two transports:

| Transport | Spec block                                      | When to use                                        |
| --------- | ----------------------------------------------- | -------------------------------------------------- |
| `stdio`   | `transport: stdio`, `command`, `args`           | The runtime spawns the server. Local tooling.       |
| `sse`     | `transport: sse`, `url`                         | Server runs separately. Networked / shared servers. |

Run the smoke:

```bash
bun run compile:mcp-smoke
bun run run:mcp-smoke
```

The runtime:

1. Spawns `npx @modelcontextprotocol/server-everything` on startup.
2. Sends the MCP handshake; receives the server's tool list.
3. Registers each remote tool in the catalog as `everything__<toolName>`.
4. Forwards the server's JSON Schema for each tool to the model.

Type a prompt like "echo hello using the everything server". The
model calls `everything__echo`, the runtime forwards the call over
stdio, the server returns, and the assistant prints the result.

## Why the `serverName__` prefix

Without prefixing, two MCP servers exposing a `read` tool would
collide. The prefix makes every remote tool name globally unique and
gives the agent a visible signal which server it's calling.

So if you have:

```yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
```

…the model sees `filesystem__read_file`, `filesystem__list_directory`,
`github__create_issue`, `github__list_pulls`, etc. Built-in tools
keep their bare names (`Read`, `Write`, `Bash`).

## What the runtime forwards to the model

For each remote tool the runtime forwards **verbatim**:

- The tool name (prefixed).
- The tool description (the server's own description).
- The tool's JSON Schema (input parameters).

The model treats `everything__echo` exactly like a local tool — its
prompt-rendered tool list includes the remote tool's description and
schema, and the model picks which to call.

When the model calls a remote tool:

1. The runtime serializes the args as MCP `tools/call` JSON-RPC.
2. The MCP server responds with `{ content: [...] }`.
3. The runtime classifies the content via [`boundary-classifier`](../../packages/boundary-classifier)
   with `origin: "mcp"` (see [Recipe 41](41-security-fabric.md)).
4. The classified content becomes the `tool_result` for the model.

## Auto-reconnect

If the MCP server crashes mid-run:

- The runtime catches the connection error.
- All in-flight calls fail with a `transient` error reason.
- A reconnect timer starts: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... with
  ±10% jitter. **No max attempt count** — the runtime keeps trying
  until reconnect succeeds.
- During reconnection, new tool calls wait on a queue **capped at
  16**. Past 16, the runtime returns "MCP server unavailable" rather
  than building unbounded backlog.

To watch reconnect behavior, set `CREWHAUS_TRACE=pretty`:

```
[mcp:everything] disconnected (reason=eof)
[mcp:everything] reconnect attempt 1 in 1.02s
[mcp:everything] reconnect attempt 1 connected; 8 tools re-registered
```

## Per-tool flag overrides

The MCP protocol doesn't carry the `destructive` / `audit-and-allow`
flags the crewhaus permission engine uses. Without overrides, every
remote tool is treated as `internal` (no extra gating).

Override per remote tool:

```yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
tool_config:
  mcp:
    filesystem:
      write_file:
        destructive: true
    github:
      create_issue:
        destructive: true
      list_pulls:
        sideEffect: internal       # the default, just being explicit
```

With `destructive: true`, the tool is gated by the permission engine
just like the built-in `Write`/`Bash`. With `audit-and-allow`, every
call records an audit-log entry but otherwise proceeds.

## Permissions on MCP tools

Permissions rules match against the prefixed tool name:

```yaml
permissions:
  rules:
    - type: alwaysAllow
      pattern: filesystem__read_file
    - type: alwaysAsk
      pattern: filesystem__write_file
    - type: alwaysDeny
      pattern: github__create_repository
```

The pattern grammar is identical to built-in tools (covered in
[Recipe 29](29-permissions-deep-dive.md)).

## Multiple servers, one spec

There's no limit. Each server runs in its own subprocess (stdio) or
maintains its own SSE connection, with no shared state between them.
The runtime fans out tool calls in parallel when the model asks for
several at once.

A typical production CLI agent might have 3-5 MCP servers wired:

```yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
  git:
    transport: stdio
    command: mcp-git
  postgres:
    transport: sse
    url: https://mcp-pg.internal/sse
  sentry:
    transport: sse
    url: https://mcp-sentry.internal/sse
```

## Writing your own MCP server

The MCP spec ([modelcontextprotocol.io](https://modelcontextprotocol.io))
defines the wire protocol. SDKs exist for TypeScript, Python, and
Rust. The minimum tool server is ~50 lines:

```typescript
// my-mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server";

const server = new McpServer({ name: "my-server", version: "0.1.0" });

server.tool({
  name: "greet",
  description: "Greet someone by name",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"]
  }
}, async ({ name }) => {
  return { content: [{ type: "text", text: `Hello, ${name}!` }] };
});

server.connect();
```

Run via `bun my-mcp-server.ts` (or compile to a binary). Reference it
from your spec with `command: bun`, `args: ["./my-mcp-server.ts"]`.

## Debugging MCP traffic

Set `CREWHAUS_MCP_DEBUG=1` to log every MCP message to stderr:

```
[mcp:everything →] {"jsonrpc":"2.0","id":3,"method":"tools/list"}
[mcp:everything ←] {"jsonrpc":"2.0","id":3,"result":{"tools":[...]}}
[mcp:everything →] {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"msg":"hi"}}}
[mcp:everything ←] {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"hi"}]}}
```

Useful when the model is "missing" a remote tool or when call results
look wrong.

## Things that look like MCP but aren't

| Symptom                                                                | Use instead                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| The tool is one TypeScript function in your repo.                      | [`tool-builder`](../../packages/tool-builder)     |
| You want fine-grained typed RPC, not freeform tools.                   | A regular HTTP client + a `Fetch` allow-list      |
| You're calling another crewhaus deployment.                            | [Recipe 27 — Federation](27-federation.md)        |
| You're wrapping a shell command.                                       | `Bash` with permissions rules                     |

MCP shines when the tool **already exists** as an MCP server or when
you want a tool to be **language-agnostic and reusable** across
deployments.

## What to read next

- **Permissions for remote tools.** [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).
- **Distributing your own MCP servers.** [Recipe 26 — Template Marketplace](26-template-marketplace.md).
- **Security on MCP responses.** [Recipe 41 — Security Fabric](41-security-fabric.md)
  — every MCP response is classified before reaching the model.

## Pointers to source

- **Example:** [`examples/mcp-smoke/crewhaus.yaml`](../../examples/mcp-smoke/crewhaus.yaml).
- **Host (lifecycle, reconnect):** [`packages/mcp-host`](../../packages/mcp-host).
- **Tool layer:** [`packages/tool-mcp`](../../packages/tool-mcp).
- **Boundary classifier (origin: "mcp"):** [`packages/boundary-classifier`](../../packages/boundary-classifier).
- **Module catalog reference:** §9 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
