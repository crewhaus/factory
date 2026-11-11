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

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boundaryRuleIds, classifyBoundary } from "@crewhaus/boundary-classifier";
import { constantTimeEquals } from "@crewhaus/gateway-protocol/control";
import type {
  McpInvoke,
  McpSubAgentDescriptor,
  McpToolsMode,
  McpTransportKind,
} from "@crewhaus/mcp-server";
import { type InboundContent, withInboundContent } from "@crewhaus/run-context";
import { isLoopbackHost } from "./remote-bind";

/** Thrown for a misconfigured `serve --mcp` invocation (unsupported target,
 *  `per-subagent` with no sub-agents, bad `--port`). The CLI routes the message
 *  through `die()`; tests assert on `.message`. */
export class ServeMcpError extends Error {
  override readonly name = "ServeMcpError";
}

export const SERVE_MCP_USAGE =
  "usage: crewhaus serve --mcp <spec.yaml> [--sse] [--port <n>] [--host <address>]\n" +
  "                      [--model <m>]\n" +
  "                      [--permission-mode <default|plan|auto|bypass>]\n" +
  "                      [--ask-mode <pause|deny>] [--plugins <a,b>]\n" +
  "  Projects the spec's agent as an MCP server so Claude Code / an IDE / another\n" +
  "  CrewHaus runtime can call it as a tool. Each tool call runs one agent turn\n" +
  "  (the same interpreter `crewhaus run` drives) and returns the final reply.\n" +
  "\n" +
  "  --mcp        required — the projection kind (the only kind today).\n" +
  "  --sse        serve over HTTP+SSE (a `fetch` server on --port) instead of\n" +
  "               stdio; overrides the spec's `expose.mcp.transport`.\n" +
  "               listens on this computer unless --host says otherwise, and\n" +
  "               asks for `Authorization: Bearer <token>`: CREWHAUS_MCP_TOKEN,\n" +
  "               else a token saved at each start to .crewhaus/run/mcp-token (0600).\n" +
  "  --port <n>   SSE listen port (default 8000, or CREWHAUS_MCP_PORT). Ignored\n" +
  "               for stdio.\n" +
  "  --host <address>  another SSE listen address; beyond this computer it needs\n" +
  "               CREWHAUS_MCP_TOKEN of at least 32 characters. Ignored for stdio.\n" +
  "  A tool call's message is classified at `api` before its turn, on stdio and\n" +
  "  --sse: a malicious one is refused with a tool error naming input_blocked.\n" +
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

/** The variable that sets the `--sse` listener's bearer, as for a channel bundle's `/mcp`. */
export const SERVE_TOKEN_ENV = "CREWHAUS_MCP_TOKEN";
/** Where a start saves the bearer it made when {@link SERVE_TOKEN_ENV} is unset, under the cwd. */
export const SERVE_TOKEN_FILE = ".crewhaus/run/mcp-token";

/** The `--sse` listener's bearer, and where it came from, for the banner. */
export type ServeBearer = { readonly token: string; readonly source: string };

/** Where the `--sse` listener binds, and whether that address reaches only this computer. */
export type ServeBind = { readonly hostname: string; readonly loopback: boolean };

/** The shortest {@link SERVE_TOKEN_ENV} a listener beyond this computer takes. */
export const SERVE_REMOTE_TOKEN_MIN = 32;

/**
 * Where the `--sse` listener binds. With no `--host` it is `127.0.0.1`. A
 * loopback address (`127.0.0.0/8`, `::1` bracketed or not, `localhost`) is
 * taken as given. Any other address or name listens beyond this computer, so
 * it needs {@link SERVE_TOKEN_ENV} of at least {@link SERVE_REMOTE_TOKEN_MIN}
 * characters, chosen by a person rather than saved by the start. A name is
 * never resolved here. Throws {@link ServeMcpError} for an empty value, one
 * holding a space, a slash or a port, and a remote one without that variable.
 */
export function resolveServeBind(
  hostFlag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ServeBind {
  if (hostFlag === undefined) return { hostname: "127.0.0.1", loopback: true };
  const hostname = hostFlag.trim().replace(/^\[(.*)\]$/, "$1");
  if (hostname === "" || /[\s/[\]]/.test(hostname) || /^[^:]+:\d*$/.test(hostname)) {
    throw new ServeMcpError(
      `invalid --host "${hostFlag}": expected an address or a name, with the port in --port`,
    );
  }
  if (isLoopbackHost(hostname)) return { hostname, loopback: true };
  if ((env[SERVE_TOKEN_ENV] ?? "").length < SERVE_REMOTE_TOKEN_MIN) {
    throw new ServeMcpError(
      `--host ${hostname} listens beyond this computer: set ${SERVE_TOKEN_ENV} to at least ${SERVE_REMOTE_TOKEN_MIN} characters first (openssl rand -hex 32). The bearer travels as sent, so keep the listener on a private network or behind TLS.`,
    );
  }
  return { hostname, loopback: false };
}

/**
 * The name a request's `Host` header gives, lower-cased and without its port,
 * an IPv6 address keeping its brackets; `""` for a missing or malformed one.
 */
function requestHostName(req: Request): string {
  const host = (req.headers.get("host") ?? "").trim().toLowerCase();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1 || !/^(:\d+)?$/.test(host.slice(close + 1))) return "";
    return host.slice(0, close + 1);
  }
  return host.replace(/:\d+$/, "");
}

/** True when an `Origin` names this computer or the name the request's `Host` gave. */
function originAllowed(origin: string, name: string): boolean {
  try {
    const o = new URL(origin).hostname.toLowerCase();
    return isLoopbackHost(o) || o === name;
  } catch {
    return false; // `null` from a sandboxed page, or anything unparseable.
  }
}

/**
 * The bearer an `--sse` start answers to. {@link SERVE_TOKEN_ENV} wins and
 * nothing is written. Otherwise 32 random bytes, as hex, are saved at
 * {@link SERVE_TOKEN_FILE} under `cwd` at 0600, beside a `.gitignore` of `*`
 * when that directory has none. The file is removed and then created with
 * `wx`, so a link already at that path is replaced and its target is left as
 * it was, and a token left by an earlier start does not answer for this one.
 * Throws {@link ServeMcpError} naming the variable when saving the file fails.
 */
export function resolveServeBearer(opts: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ServeBearer {
  const fromEnv = opts.env[SERVE_TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv, source: SERVE_TOKEN_ENV };
  const file = join(opts.cwd, SERVE_TOKEN_FILE);
  const token = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    rmSync(file, { force: true });
    try {
      writeFileSync(join(dirname(file), ".gitignore"), "*\n", { flag: "wx" });
    } catch {
      // A `.gitignore` is already there, and it stays as it is.
    }
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    throw new ServeMcpError(
      `set ${SERVE_TOKEN_ENV}: no token is set, and one could not be saved to ${file}: ${(err as Error).message}`,
    );
  }
  return { token, source: `${SERVE_TOKEN_FILE} (minted this boot, 0600)` };
}

/**
 * The refusal for a request the `--sse` listener does not answer, or
 * undefined for one it does. The Host and Origin check comes first and
 * answers 403: on a loopback bind the `Host` must name this computer, and on
 * any bind an `Origin`, when sent, must name this computer or the request's
 * own `Host`. A non-loopback bind does not check `Host`, since which name
 * reaches it is the operator's to choose. Then the request must carry
 * `Authorization: Bearer <token>` with this listener's token, compared in
 * constant time, or it is answered 401 with `www-authenticate: Bearer`, as a
 * channel bundle's `/mcp` answers. It runs before the MCP handler, so before
 * any session is looked up.
 */
export function serveRequestRefusal(
  req: Request,
  bind: ServeBind,
  token: string,
): Response | undefined {
  const name = requestHostName(req);
  const origin = req.headers.get("origin");
  if (
    (bind.loopback && !isLoopbackHost(name)) ||
    (origin !== null && !originAllowed(origin, name))
  ) {
    return new Response(SERVE_HOST_REFUSAL, { status: 403 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !constantTimeEquals(auth.slice(7), token)) {
    return new Response(
      JSON.stringify({ error: "unauthorized: send Authorization: Bearer <token>" }),
      {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
      },
    );
  }
  return undefined;
}

/** The body of the 403 a request gets when its `Host` or `Origin` is not answered. */
export const SERVE_HOST_REFUSAL = "this server does not answer that Host or Origin";

/** Where a served call's message enters, in its run's inbound entry and warning line. */
export const SERVE_MCP_DOOR = "serve --mcp";

/**
 * Classify a tool call's message at TrustOrigin `api`: the entry its turn
 * adopts when the message is kept, with the verdict (never the text) when it
 * is kept with a warning. A malicious message throws {@link ServeMcpError}
 * naming `input_blocked` and the rule ids, never the message.
 */
async function screenServeMessage(message: string): Promise<InboundContent> {
  const boundary = await classifyBoundary(message, { origin: "api" });
  const rules = boundaryRuleIds(boundary.verdict);
  if (boundary.action === "redact") {
    throw new ServeMcpError(
      `input_blocked: input refused by the prompt-injection check (rules: ${rules.join(", ")})`,
    );
  }
  return {
    content: message,
    origin: "api",
    door: SERVE_MCP_DOOR,
    ...(boundary.action === "warn" ? { warning: { rules, score: boundary.verdict.score } } : {}),
  };
}

/**
 * The served `invoke`: each call's message is classified at `api` before its
 * turn ({@link screenServeMessage}). A malicious one is refused before it
 * takes a place in `serialize`'s queue, so no turn runs and no model is
 * called; the MCP layer answers the throw as a tool error. A kept one runs
 * `turn` through `serialize`, one turn at a time, inside a run-context scope
 * opened within the queued function, so the first `RunContext` the turn
 * creates adopts this call's own message, tagged at `api`.
 */
export function screenedInvoke(
  serialize: <T>(fn: () => Promise<T>) => Promise<T>,
  turn: McpInvoke,
): McpInvoke {
  return async (message, context) => {
    const entry = await screenServeMessage(message);
    return serialize(() => withInboundContent([entry], () => turn(message, context)));
  };
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
