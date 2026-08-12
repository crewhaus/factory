/**
 * Item 1 (G30) — `crewhaus serve --mcp <spec> [--sse]`. The CLI half of the
 * MCP-server PROJECTION: it compiles the spec in memory, builds an
 * `invoke(message)` from the SAME `crewhaus run` interpreter turn function, and
 * hands it to `@crewhaus/mcp-server` bound to a transport — so a CrewHaus agent
 * becomes a tool inside Claude Code / IDEs / other CrewHaus runtimes.
 *
 * The runtime wiring (tool/MCP/memory/sub-agent setup + `runChatLoop`) lives in
 * the entry file `index.ts`, where every composition-root helper is in scope.
 * The pure decisions — how the spec's `expose.mcp` block + the `--sse`/`--port`
 * flags resolve into a transport, tool-projection mode, port, and the
 * sub-agent tool descriptors — are factored out HERE so they are unit-testable
 * without booting a server (the entry file runs an argv switch on import).
 * Mirrors the `dev.ts` / `marketplace-cli.ts` split.
 */

import type { McpSubAgentDescriptor, McpToolsMode, McpTransportKind } from "@crewhaus/mcp-server";

/** Thrown for a misconfigured `serve --mcp` invocation (unsupported target,
 *  `per-subagent` with no sub-agents, bad `--port`). The CLI routes the message
 *  through `die()`; tests assert on `.message`. */
export class ServeMcpError extends Error {
  override readonly name = "ServeMcpError";
}

export const SERVE_MCP_USAGE =
  "usage: crewhaus serve --mcp <spec.yaml> [--sse] [--port <n>] [--model <m>]\n" +
  "                      [--permission-mode <default|plan|auto|bypass>]\n" +
  "                      [--ask-mode <pause|deny>] [--plugins <a,b>]\n" +
  "  Projects the spec's agent as an MCP server so Claude Code / an IDE / another\n" +
  "  CrewHaus runtime can call it as a tool. Each tool call runs one agent turn\n" +
  "  (the same interpreter `crewhaus run` drives) and returns the final reply.\n" +
  "\n" +
  "  --mcp        required — the projection kind (the only kind today).\n" +
  "  --sse        serve over HTTP+SSE (a `fetch` server on --port) instead of\n" +
  "               stdio; overrides the spec's `expose.mcp.transport`.\n" +
  "  --port <n>   SSE listen port (default 8000, or CREWHAUS_MCP_PORT). Ignored\n" +
  "               for stdio.\n" +
  "  The tool projection follows the spec's `expose.mcp.tools` (default `chat` —\n" +
  "  one tool for the whole agent; `per-subagent` also projects one tool per\n" +
  "  declared sub-agent). `--model` / `--permission-mode` / `--ask-mode` /\n" +
  "  `--plugins` thread through exactly as on `crewhaus run`.\n" +
  "\n" +
  "  --ask-mode <pause|deny> matters most here: a daemon has no stdin to prompt\n" +
  "  on, so a tool permission that resolves to `ask` either parks the turn\n" +
  "  (pause, the default — the caller gets an error naming the approval id, and\n" +
  "  `crewhaus approvals grant <id>` releases it for the next identical call) or\n" +
  "  is refused in place (deny). Overrides the spec's `permissions.ask_mode`.\n";

/** Default SSE listen port when neither `--port` nor `CREWHAUS_MCP_PORT` is set. */
export const SERVE_MCP_DEFAULT_PORT = 8000;

/** The one target shape `serve --mcp` projects today — the interpreter turn
 *  function it reuses is the cli run path (`runRunCli`). channel/managed carry
 *  `expose` in IR too, but they self-expose from their compiled daemon (the SSE
 *  `fetch` path), not through `serve`. */
export const SERVE_MCP_SUPPORTED_TARGET = "cli";

/**
 * Resolve the wire transport. `--sse` (or the spec's `expose.mcp.transport:
 * sse`) selects SSE; otherwise stdio — the default a spec with no `expose`
 * block, or `expose.mcp.transport: stdio`, projects. The explicit flag wins so
 * `--sse` can force SSE over a `stdio` spec.
 */
export function resolveMcpTransport(
  sseFlag: boolean,
  exposeTransport: McpTransportKind | undefined,
): McpTransportKind {
  return sseFlag || exposeTransport === "sse" ? "sse" : "stdio";
}

/**
 * Resolve the tool-projection mode from the spec's RESOLVED `expose.mcp.tools`
 * (the lower step already defaulted it to `"chat"`). Absent `expose` block →
 * `"chat"`, the whole-agent projection.
 */
export function resolveMcpToolsMode(exposeTools: McpToolsMode | undefined): McpToolsMode {
  return exposeTools ?? "chat";
}

/**
 * Resolve the SSE listen port: `--port` flag > `CREWHAUS_MCP_PORT` env >
 * {@link SERVE_MCP_DEFAULT_PORT}. Throws {@link ServeMcpError} on a non-integer
 * or out-of-range value so a typo fails loudly instead of binding port 0/NaN.
 */
export function resolveServePort(
  portFlag: string | undefined,
  envPort: string | undefined,
): number {
  const raw = portFlag ?? envPort;
  if (raw === undefined || raw === "") return SERVE_MCP_DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ServeMcpError(
      `invalid port "${raw}" — expected an integer in 1..65535${portFlag === undefined ? " (from CREWHAUS_MCP_PORT)" : ""}`,
    );
  }
  return n;
}

/**
 * Guard: `serve --mcp` reuses the cli interpreter turn function, so only a
 * `target: cli` spec can be projected today. A compile-only shape (or a daemon
 * shape that self-exposes) gets a clear, actionable error.
 */
export function assertServeTargetSupported(target: string): void {
  if (target !== SERVE_MCP_SUPPORTED_TARGET) {
    throw new ServeMcpError(
      // #394 — this sentence used to promise a capability the emit did not
      // produce: `expose.mcp` was carried through spec→IR and read by no
      // emitter, so "self-exposes from its compiled bundle" was true of
      // nothing. The channel emit now really does mount it, so the pointer is
      // honest — and it names the endpoint rather than leaving an operator to
      // guess, which is what made the original text circular.
      `crewhaus serve --mcp supports target: ${SERVE_MCP_SUPPORTED_TARGET} (got "${target}"). Only the cli agent's turn function projects as an MCP server through \`serve\`. A CHANNEL bundle self-exposes instead: set \`expose.mcp.transport: sse\`, compile, and the daemon serves MCP at \`/mcp\` on its public port (PORT, default 3000) behind a bearer — it prints the URL and the token source at boot. A MANAGED bundle does NOT self-expose yet; compile warns that \`expose.mcp\` is carried-but-unwired there.`,
    );
  }
}

/**
 * Project the IR sub-agents onto the {@link McpSubAgentDescriptor} list
 * `createMcpServer({ tools: "per-subagent" })` registers one tool from. The MCP
 * layer sanitizes each `name` into a tool name and hands it back through the
 * invoke context; the `description` is shown to the calling model.
 */
export function buildMcpSubAgentDescriptors(
  subAgents: ReadonlyArray<{ readonly name: string; readonly description: string }>,
): McpSubAgentDescriptor[] {
  return subAgents.map((sa) => ({ name: sa.name, description: sa.description }));
}

/**
 * Cross-check the tool-projection mode against the sub-agent count. The spec's
 * cross-field validation already guarantees `per-subagent` implies at least one
 * sub-agent, and `@crewhaus/mcp-server` re-checks it — this surfaces the same
 * invariant as a friendly CLI error if a hand-edited/older bundle slips
 * through, before a server is booted.
 */
export function assertToolsModeSatisfiable(mode: McpToolsMode, subAgentCount: number): void {
  if (mode === "per-subagent" && subAgentCount === 0) {
    throw new ServeMcpError(
      "expose.mcp.tools: per-subagent requires at least one sub_agents entry — none are declared",
    );
  }
}

/**
 * Filter a parent tool list down to a sub-agent's `tools:` allowlist (the child
 * catalog `per-subagent` routing runs that sub-agent's turn with). Mirrors the
 * name-filter the Task-tool / codegen apply when building a child catalog from
 * `IrSubAgentDefinition.tools` (a resolved `readonly string[]`).
 */
export function filterChildTools<T extends { readonly name: string }>(
  tools: ReadonlyArray<T>,
  allow: ReadonlyArray<string>,
): T[] {
  const names = new Set(allow);
  return tools.filter((t) => names.has(t.name));
}
