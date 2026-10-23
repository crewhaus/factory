/**
 * Which recorded tool names are builtins (`@crewhaus/tool-categories`), which
 * an MCP server serves, and the ones whose result formats the evidence index
 * and the verifiers read.
 */
import { builtinKeyForName } from "@crewhaus/tool-categories";

/** tool-web's fetcher: its result opens with a `URL: …\nStatus: …` header. */
export const WEB_FETCH = "WebFetch";
/** tool-fetch's fetcher: its result opens with `HTTP <status>` and the headers. */
export const FETCH = "Fetch";
/** tool-fs's reader: its result is the file's text. */
export const READ = "Read";
/** tool-retrieve's tool (pipeline and every `knowledge:` corpus): `[n] id=… doc=… score=…` hits. */
export const RETRIEVE = "Retrieve";
/** tool-proof's checker tool: its result is the JSON report of the artifact it wrote. */
export const PROOF_CHECK = "ProofCheck";

/**
 * Is `name` a tool an MCP server serves (`mcp__<server>__<tool>`, tool-mcp's
 * naming)? Its result is what that server returned — classified at the
 * `mcp` origin on the way in — never text the run's own model wrote. The
 * runtime's other non-builtin tools are not: `Task` returns a sub-agent's
 * final message, `Consult`/`Escalate` a sibling model's reply, `Skill` a
 * skill body, the memory, plan and goal tools what a model stored.
 */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/** Builtin keys by recorded name, memoized: the table is 500+ entries long. */
const keys = new Map<string, string | undefined>();

/** The builtin spec key a recorded tool name maps to (case-insensitively), or `undefined`. */
export function builtinKey(name: string): string | undefined {
  if (!keys.has(name)) keys.set(name, builtinKeyForName(name));
  return keys.get(name);
}
