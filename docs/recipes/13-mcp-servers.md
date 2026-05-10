# Recipe 13 — MCP Servers

> **Status:** stub.

## What you'll learn

Wire a [Model Context Protocol](https://modelcontextprotocol.io)
server into your spec so its tools become callable by the agent.
Supports both stdio and SSE transports, with auto-reconnect, and
namespaces remote tools as `<serverName>__<toolName>` so they don't
clash with built-ins.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The `mcp_servers:` block — `transport: stdio | sse`, `command` + `args`, or `url`.
2. What the bundle does at boot: `McpHost.addServer()` → `connect()` → `registerMcpServer()` lists remote tools and adds them to the catalog.
3. Tool naming: every remote tool is registered as `<serverName>__<toolName>`. Why: namespacing.
4. Remote schemas: the runtime forwards each remote tool's JSON Schema verbatim to the model.
5. Per-tool flag overrides via `opts.perTool` — mark a remote tool `destructive: true` even if the server didn't.
6. Auto-reconnect: 1s → 30s exponential backoff with ±10% jitter, no max attempts, queue-capped (16) for in-flight calls.
7. Multiple MCP servers in one spec — independent connections, no shared state.
8. Smoke test against `@modelcontextprotocol/server-everything`.

## Run it now

```bash
bun run compile:mcp-smoke
bun run run:mcp-smoke
```

## Pointers to existing material

- **Example:** [`examples/mcp-smoke/crewhaus.yaml`](../../examples/mcp-smoke/crewhaus.yaml).
- **Modules:** [`packages/mcp-host`](../../packages/mcp-host), [`packages/tool-mcp`](../../packages/tool-mcp).
- **Catalog:** §9.

## Where to go next

- To restrict which MCP tools the agent may call → [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).
- To add new MCP servers from a marketplace → [Recipe 26 — Template Marketplace](26-template-marketplace.md).
