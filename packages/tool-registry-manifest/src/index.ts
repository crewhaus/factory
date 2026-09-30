/**
 * @crewhaus/tool-registry-manifest — every builtin tool this release ships,
 * as data a compiled bundle can carry.
 *
 * WHAT THIS IS FOR. A running harness can already answer "what can I call
 * right now": `ListTools` reads the live catalog and is authoritative, MCP
 * peers included. It cannot answer the other question — "what exists in this
 * framework that I am not running" — because a bundle contains only the tools
 * its spec granted. This package is that second answer, so an operator can
 * see what the agent is missing and decide whether to give it.
 *
 * WHAT THIS IS NOT. It is a description, not a control. In any harness that
 * grants bash, file write or code execution, an agent can edit `crewhaus.yaml`
 * itself; nothing here stands between an agent and a tool, and nothing in this
 * package claims to. Leaving a tool out of a spec is what shapes a harness;
 * this file just makes the omission legible.
 *
 * WHY GENERATED. There is no other source for it. The builtin table
 * (`BUILTIN_TOOLS` in `@crewhaus/tool-categories`) carries a package, an
 * export and a name with no prose, and must never import a tool package — the
 * compiler imports it and codegen stays offline. The descriptions and flags
 * exist only on the `RegisteredTool` objects, reachable only by importing
 * every tool package, which the CLI does and every `packages/*` must not. So the
 * data is projected once, by `scripts/gen-tool-registry.ts`, and checked into
 * `src/generated.ts` — the shape `packages/docker-images` already uses for its
 * Dockerfile bodies.
 *
 * MCP IS ABSENT AND CANNOT BE ADDED. A spec declares an MCP *server*; the
 * server's tool list only exists once it is connected, and `watchMcpServer`
 * re-diffs it mid-run. "Which MCP tools exist that I lack" has no offline
 * answer, so no `mcp__` name appears here and any reader must say so rather
 * than let its absence read as "there are none".
 *
 * FLAGS WITHOUT PROSE. `@crewhaus/tool-registry-manifest/flags` exports
 * `TOOL_FLAGS`: the same rows less descriptions, categories and keywords, for
 * a bundle that only reasons about how a tool is gated.
 *
 * DEPENDENCY-FREE on purpose, like `@crewhaus/tool-categories`: anything that
 * needs to describe a tool can depend on this without dragging a tool
 * implementation, the compiler or a network stack behind it.
 */
export { REGISTRY_VERSION, TOOL_REGISTRY } from "./generated";
export {
  type RegistryEntry,
  type RegistryOperativeArg,
  type ToolFlags,
  projectRegistryEntry,
  projectToolFlags,
} from "./types";
