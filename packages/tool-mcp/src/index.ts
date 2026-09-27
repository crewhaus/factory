import { createHash } from "node:crypto";
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { McpError } from "@crewhaus/errors";
import type {
  McpClient,
  McpHost,
  McpServerConfig,
  McpToolDefinition,
  McpToolFlagsConfig,
} from "@crewhaus/mcp-host";
import { nextBackoffMs } from "@crewhaus/mcp-host";
import { toolDefinitionHits, withExtraHits } from "@crewhaus/prompt-injection-detector";
import { type RunContext, tagContent } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import {
  type RegisteredTool,
  type ToolCatalog,
  type ToolExecuteContext,
  mcpToolName,
  toolListEntryNames,
} from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Wrap an MCP server's remote tools as `RegisteredTool` entries on the
 * shared catalog. Catalog R4 (`tool-mcp`).
 *
 * Naming: each remote tool is registered as `mcp__<serverName>__<toolName>`
 * (0.7.1; before that `<serverName>__<toolName>`), so tools from different
 * servers can never collide and every MCP tool is recognisable by name. That
 * is the spelling the docs, the spec's model-profile selectors, the egress
 * fabric and the scope audit all key on. Permission rules, skill and
 * sub-agent tool lists, hook matchers and rate limits written against the old
 * spelling keep matching. Server names are user-controlled YAML keys
 * (validated at the spec layer and again here); remote tool names are
 * server-controlled and validated here.
 *
 * Schema: MCP tools' authoritative schema is JSON Schema. We keep that
 * verbatim on `RegisteredTool.jsonSchema` (forwarded to the model by
 * `runtime-core`) and use `z.unknown()` as the local validator slot, so
 * the validator path passes everything through and the MCP server itself
 * is the source of truth for argument validation.
 */

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * An MCP server name: the characters a tool name can carry — letters,
 * digits, `-` and `_` — because it becomes part of every tool the server
 * contributes (`mcp__<server>__<tool>`).
 *
 * A name that also contains `__`, or starts or ends with `_` or `-`, still
 * registers: crewhaus 0.7.0 ran such servers and a patch release keeps them
 * running. The spec warns about them (see `mcpServerNameWarning` in
 * `@crewhaus/spec`), because `__` is also the separator — server `a` + tool
 * `b__c` and server `a__b` + tool `c` register the same name.
 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Model providers accept tool names up to this long. */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Why `name` cannot be an MCP server name, or undefined when it can. The
 * message says what to write instead, so the spec layer and the runtime give
 * the same answer.
 */
export function mcpServerNameProblem(name: string): string | undefined {
  if (MCP_SERVER_NAME_PATTERN.test(name)) return undefined;
  const suggestion =
    name
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/_{2,}/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "") || "my-server";
  return `MCP server name "${name}" can only use letters, digits, "-" and "_", e.g. "${suggestion}".`;
}

export type McpToolFlags = {
  readonly concurrencySafe?: boolean;
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  /** Pillar 3 intent gate — set for remote tools whose local twins are
   *  justification-gated (e.g. the Thredz backend's `wiki_write`), so the
   *  backend flip never silently drops the gate. Default false. */
  readonly requireJustification?: boolean;
};

/**
 * How a remote tool's trust flags are decided, most permissive first:
 *
 * 1. the caller's `defaults` / `perTool` (a runtime that knows the server,
 *    such as the Thredz backend's justification-gated tools);
 * 2. the spec's `mcp_servers.<n>.tool_flags`, carried on the server's config
 *    (`McpServerConfig.toolFlags`) — `destructive` and `requireJustification`
 *    can only be turned ON;
 * 3. the server's own `ToolAnnotations`: `destructiveHint: true` makes the
 *    tool destructive and `readOnlyHint: false` makes it not read-only; the
 *    opposite hints are ignored, because a remote server's claim may tighten
 *    a tool but never loosen it.
 *
 * A destructive tool is never read-only: read-only is a grant (plan and auto
 * mode run such a tool without asking), so it cannot survive a tightening.
 */
export type RegisterMcpServerOptions = {
  /** Default flags applied to every tool from this server. */
  readonly defaults?: McpToolFlags;
  /**
   * Per-tool flag overrides keyed by remote tool name (NOT the namespaced
   * `mcp__<server>__<tool>` form). Wins over `defaults`.
   */
  readonly perTool?: Readonly<Record<string, McpToolFlags>>;
  /** Logger callback fired once per registered tool. Useful for boot banners. */
  readonly onRegister?: (info: { fullName: string; remoteName: string }) => void;
  /**
   * Fired for a remote tool that is left out: its name is not one a model
   * provider accepts ({@link mcpToolNameProblem}), or its definition is too
   * large to screen or reads as a prompt injection
   * ({@link mcpToolDefinitionProblem}). The server's other tools are
   * registered either way. `reason` never quotes the definition's text.
   * Default: `console.warn(reason)`.
   */
  readonly onSkip?: (info: { fullName: string; remoteName: string; reason: string }) => void;
  /**
   * Fired for a remote tool that IS registered, but with part of its
   * definition withheld from the model: its description, or the descriptive
   * text of its input schema (descriptions, titles, defaults, examples),
   * read as a prompt injection ({@link screenMcpToolDefinition}). `reason`
   * names the rules that fired, never the text. Default:
   * `console.warn(reason)`.
   */
  readonly onWithhold?: (info: { fullName: string; remoteName: string; reason: string }) => void;
};

/**
 * The longest description a remote tool carries into the model's context. A
 * longer one is cut here and marked as cut. What one SERVER can put in front
 * of the model is bounded separately, by {@link MAX_MCP_SERVER_DEFINITION_CHARS}
 * and {@link MAX_MCP_SERVER_TOOLS}: per-tool caps alone let a server fill the
 * window with many tools.
 */
export const MAX_MCP_DESCRIPTION_CHARS = 4096;

/**
 * The most definition text — names, descriptions and input schemas as JSON,
 * as the model is shown them — one server's tools may put in front of the
 * model. Every request carries them, so without a budget a server listing
 * many tools just under the per-tool caps could fill the context window and
 * fail every request. Tools past the budget are left out, in listing order,
 * and reported through `onSkip`. Real servers use a small part of it (a
 * browser-automation or code-hosting server lists about 20–30 KiB).
 */
export const MAX_MCP_SERVER_DEFINITION_CHARS = 256 * 1024;

/** The most tools one server may register; later ones are left out and reported. */
export const MAX_MCP_SERVER_TOOLS = 256;

/**
 * The largest input schema, measured as JSON, a remote tool may carry. A
 * larger one leaves the tool out: a schema cut short is a broken schema.
 *
 * With the description cap and the name, a whole definition fits inside the
 * window the prompt-injection detector reads in full, so no part of what the
 * model is shown goes unscreened.
 */
export const MAX_MCP_SCHEMA_CHARS = 32 * 1024;

/** How deep a remote tool's input schema may nest before it is left out. */
export const MAX_MCP_SCHEMA_DEPTH = 64;

/**
 * Why the remote tool `remoteName` on `serverName` cannot be registered under
 * `mcp__<server>__<tool>`, or undefined when it can: the name would be longer
 * than the {@link MAX_TOOL_NAME_LENGTH} characters model providers accept.
 */
export function mcpToolNameLengthProblem(
  serverName: string,
  remoteName: string,
): string | undefined {
  const fullName = namespacedToolName(serverName, remoteName);
  if (fullName.length <= MAX_TOOL_NAME_LENGTH) return undefined;
  const room = MAX_TOOL_NAME_LENGTH - (fullName.length - serverName.length);
  return `mcp server "${serverName}" tool "${remoteName}" would be registered as "${fullName}", ${fullName.length} characters; model providers accept at most ${MAX_TOOL_NAME_LENGTH}. ${
    room >= 1
      ? `Give the server a name of at most ${room} characters in mcp_servers.`
      : "The tool's own name is too long for any server name, so it cannot be offered to a model."
  }`;
}

/**
 * Why the remote tool named `remoteName` cannot be offered to a model, or
 * undefined when it can: the name is missing, uses a character outside
 * letters, digits, `-` and `_`, or makes a registered name longer than
 * {@link MAX_TOOL_NAME_LENGTH}.
 */
export function mcpToolNameProblem(serverName: string, remoteName: unknown): string | undefined {
  if (typeof remoteName !== "string" || remoteName.length === 0) {
    return `mcp server "${serverName}" returned a tool with an empty/missing name.`;
  }
  if (!TOOL_NAME_PATTERN.test(remoteName)) {
    return `mcp server "${serverName}" returned a tool with an invalid name ${shownName(remoteName)} (must match ${TOOL_NAME_PATTERN.source}), which no model provider accepts.`;
  }
  return mcpToolNameLengthProblem(serverName, remoteName);
}

/** What {@link screenMcpToolDefinition} decided about a remote tool's definition. */
export type McpDefinitionScreen =
  | {
      /** The tool is left out; `reason` says why, never quoting the definition. */
      readonly kind: "refused";
      readonly reason: string;
    }
  | {
      /**
       * The tool may be registered with `definition` — the remote one, or a
       * copy with its flagged description and schema text withheld.
       * `withheld`, when set, says what was withheld and which rules fired.
       */
      readonly kind: "shown";
      readonly definition: McpToolDefinition;
      readonly withheld?: string;
    };

/**
 * What the model may be shown of a remote tool's DEFINITION. A tool's name,
 * description and input schema are shown to the model on every request, so
 * they cross the same trust boundary as the tool's results and go through the
 * same classifier (origin `"mcp"`), once, at registration:
 *
 * - a schema larger than {@link MAX_MCP_SCHEMA_CHARS} as JSON, or nested
 *   deeper than {@link MAX_MCP_SCHEMA_DEPTH}, is refused unscreened;
 * - otherwise the name, the description as the model will see it (cut to
 *   {@link MAX_MCP_DESCRIPTION_CHARS}) and every key and string value in the
 *   schema are classified together. Most tools stop here, shown as they are.
 *
 * When that whole reads as a prompt injection, the parts are screened apart:
 *
 * - the name, the schema's property names and its other values (types,
 *   enums, patterns, …) are what the tool IS — if they read as an injection
 *   the tool is refused;
 * - the description, and the schema's descriptive text (`description`,
 *   `title`, `$comment`, `markdownDescription`, `default`, `examples`), only
 *   describe it — whichever part is flagged is withheld, and the tool is
 *   registered without it. (When only the two together read as an
 *   injection, both are withheld.)
 *
 * Tool prose that is ordinary API documentation can trip a rule written for
 * tool OUTPUT ("Override Content-Type", "rm -rf / is refused"), so a flagged
 * description costs the tool its description, not its place. A suspicious
 * verdict withholds nothing. Reasons name the rules that fired, never the text.
 */
export async function screenMcpToolDefinition(
  serverName: string,
  remote: McpToolDefinition,
): Promise<McpDefinitionScreen> {
  const label = `mcp server "${serverName}" tool ${shownName(remote.name)}`;
  const parts = schemaParts(remote.inputSchema);
  if ("problem" in parts) {
    return { kind: "refused", reason: `${label} was left out: ${parts.problem}.` };
  }
  const name = String(remote.name);
  const description = sanitizeDescription(remote.description) ?? "";
  const screen = screenDefinitionText;
  const whole = await screen([name, description, ...parts.structural, ...parts.prose].join("\n"));
  if (!whole.flagged) return { kind: "shown", definition: remote };

  const structural = await screen([name, ...parts.structural].join("\n"));
  if (structural.flagged) {
    return {
      kind: "refused",
      reason: `${label} was left out: its name or input schema reads as a prompt injection (${structural.rules}), so none of it is shown to the model.`,
    };
  }
  const descFlag = description === "" ? undefined : await screen(description).then(flaggedRules);
  const proseFlag =
    parts.prose.length === 0 ? undefined : await screen(parts.prose.join("\n")).then(flaggedRules);
  // Neither part alone reads as an injection, only the two together: withhold both.
  const both = descFlag === undefined && proseFlag === undefined;
  let withholdDesc = both ? description !== "" : descFlag !== undefined;
  let withholdProse = both ? parts.prose.length > 0 : proseFlag !== undefined;
  const shownAs = (): McpToolDefinition => ({
    ...remote,
    ...(withholdDesc
      ? {
          // Names the server's own tool, not a catalog name: an alias is
          // registered under the bare name, so this reads true either way.
          description: `Tool "${name}" of MCP server "${serverName}" (its description was withheld by crewhaus).`,
        }
      : {}),
    ...(withholdProse ? { inputSchema: withoutProse(remote.inputSchema) } : {}),
  });
  let definition = shownAs();
  let recheck = await screen(definitionText(definition));
  if (recheck.flagged && !(withholdDesc && withholdProse)) {
    withholdDesc = description !== "";
    withholdProse = parts.prose.length > 0;
    definition = shownAs();
    recheck = await screen(definitionText(definition));
  }
  if (recheck.flagged) {
    return {
      kind: "refused",
      reason: `${label} was left out: its definition reads as a prompt injection (${recheck.rules}) even with its descriptions withheld, so none of it is shown to the model.`,
    };
  }
  const what = [
    ...(withholdDesc ? ["its description"] : []),
    ...(withholdProse
      ? ["the descriptions, titles, defaults and examples in its input schema"]
      : []),
  ].join(" and ");
  const rules = [descFlag, proseFlag].filter((r): r is string => r !== undefined).join(", ");
  return {
    kind: "shown",
    definition,
    withheld: `${label}: ${what} ${withholdProse ? "read" : "reads"} as a prompt injection (${rules || whole.rules}), so crewhaus withheld ${withholdProse ? "them" : "it"} from the model. The tool is registered without ${withholdProse ? "them" : "it"}.`,
  };
}

/**
 * Why a remote tool must be left out, or undefined when it may be registered
 * (possibly with part of its definition withheld — see
 * {@link screenMcpToolDefinition}, which says which).
 */
export async function mcpToolDefinitionProblem(
  serverName: string,
  remote: McpToolDefinition,
): Promise<string | undefined> {
  const screened = await screenMcpToolDefinition(serverName, remote);
  return screened.kind === "refused" ? screened.reason : undefined;
}

/** Whether a piece of a definition reads as an injection, and the rules that fired. */
type DefinitionVerdict = { readonly flagged: boolean; readonly rules: string };

/**
 * Screen a piece of a tool definition: the boundary classifier at origin
 * `"mcp"` (the rules for tool output, plus Layer 3 when the process has
 * installed it), with the tool-definition rules folded in
 * (`TOOL_DEFINITION_RULES`: <IMPORTANT> blocks, "do not mention this to the
 * user", "pass the contents of ~/.ssh/id_rsa as …", instructions about other
 * tools, "your new task is …"). A definition is flagged when either reads it
 * as malicious. `rules` names at most six rules, never the text.
 */
async function screenDefinitionText(text: string): Promise<DefinitionVerdict> {
  const boundary = await classifyBoundary(text, { origin: "mcp" });
  const verdict = withExtraHits(boundary.verdict, toolDefinitionHits(text));
  return {
    flagged: boundary.action === "redact" || verdict.classification === "malicious",
    rules: [...new Set(verdict.hits.map((h) => h.rule))].slice(0, 6).join(", "),
  };
}

/** The rules behind a flagged verdict, or undefined when it is not one. */
function flaggedRules(verdict: DefinitionVerdict): string | undefined {
  return verdict.flagged ? verdict.rules : undefined;
}

/** Everything the model is shown of `definition`, as one text. */
function definitionText(definition: McpToolDefinition): string {
  const parts = schemaParts(definition.inputSchema);
  const schema = "problem" in parts ? [] : [...parts.structural, ...parts.prose];
  return [
    String(definition.name),
    sanitizeDescription(definition.description) ?? "",
    ...schema,
  ].join("\n");
}

/**
 * Register one remote tool, or — when it cannot be offered to a model — report
 * it through `onSkip` and register nothing. One bad tool only drops that tool:
 * the server's others are registered, and a name or definition that cannot be
 * used never leaves half a server on the catalog (0.7.0 threw part-way through
 * the list, after registering the tools before it).
 *
 * A server name that is itself invalid still fails the server: that is the
 * operator's configuration, not one of the server's tools.
 */
async function registerOne(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  remote: McpToolDefinition,
  opts: RegisterMcpServerOptions,
  budget: ServerBudget,
): Promise<void> {
  const serverProblem = mcpServerNameProblem(serverName);
  if (serverProblem !== undefined) throw new McpError(serverProblem);
  const badName = mcpToolNameProblem(serverName, remote.name);
  if (badName !== undefined) {
    reportSkip(serverName, remote, badName, opts);
    return;
  }
  const fullName = namespacedToolName(serverName, remote.name);
  if (catalog.has(fullName)) {
    reportSkip(
      serverName,
      remote,
      `mcp server "${serverName}" tool ${shownName(remote.name)} was left out: a tool named "${fullName}" is already registered.`,
      opts,
    );
    return;
  }
  // A server that already spent its tool count is not screened any further.
  const full = budgetProblem(serverName, remote.name, budget);
  if (full !== undefined) {
    reportSkip(serverName, remote, full, opts);
    return;
  }
  const screened = await screenMcpToolDefinition(serverName, remote);
  if (screened.kind === "refused") {
    reportSkip(serverName, remote, screened.reason, opts);
    return;
  }
  const tool = buildMcpRegisteredTool(
    host,
    serverName,
    screened.definition,
    resolveMcpToolFlags(opts, serverName, remote, configuredFlags(host, serverName)),
  );
  const overBudget = budgetProblem(serverName, remote.name, budget, tool);
  if (overBudget !== undefined) {
    reportSkip(serverName, remote, overBudget, opts);
    return;
  }
  if (screened.withheld !== undefined) reportWithheld(fullName, remote, screened.withheld, opts);
  catalog.register(tool);
  spend(budget, tool);
  opts.onRegister?.({ fullName: tool.name, remoteName: remote.name });
}

/** What one server's registered tools already put in front of the model. */
type ServerBudget = { chars: number; tools: number };

/** The characters of `tool`'s definition the model is shown: name, description, schema. */
function advertisedChars(tool: RegisteredTool): number {
  let schema = 0;
  try {
    schema = JSON.stringify(tool.jsonSchema ?? null)?.length ?? 0;
  } catch {
    schema = MAX_MCP_SCHEMA_CHARS;
  }
  return tool.name.length + tool.description.length + schema;
}

/**
 * The budget already spent by `serverName`'s tools on `catalog` (a retry, or
 * a reconcile that keeps the tools it did not change). Tools are found by
 * their `mcp__<server>__` prefix.
 */
function spentBudget(catalog: ToolCatalog, serverName: string): ServerBudget {
  const prefix = namespacedToolName(serverName, "");
  const budget: ServerBudget = { chars: 0, tools: 0 };
  for (const tool of catalog.list()) if (tool.name.startsWith(prefix)) spend(budget, tool);
  return budget;
}

function spend(budget: ServerBudget, tool: RegisteredTool): void {
  budget.chars += advertisedChars(tool);
  budget.tools += 1;
}

/**
 * Why registering one more tool would take `serverName` past its budget, or
 * undefined: its tool count, and — given the `tool` as the model would be
 * shown it — its definition characters.
 */
function budgetProblem(
  serverName: string,
  remoteName: string,
  budget: ServerBudget,
  tool?: RegisteredTool,
): string | undefined {
  const label = `mcp server "${serverName}" tool ${shownName(remoteName)} was left out`;
  if (budget.tools >= MAX_MCP_SERVER_TOOLS) {
    return `${label}: the server already registered ${budget.tools} tools, the most one server may register (${MAX_MCP_SERVER_TOOLS}). Configure the server to offer fewer tools.`;
  }
  if (tool === undefined) return undefined;
  const size = advertisedChars(tool);
  if (budget.chars + size > MAX_MCP_SERVER_DEFINITION_CHARS) {
    return `${label}: its definition is ${size} characters, and the server's tools already put ${budget.chars} in front of the model on every request; one server may put at most ${MAX_MCP_SERVER_DEFINITION_CHARS}. Configure the server to offer fewer tools.`;
  }
  return undefined;
}

/** Report a remote tool registered with part of its definition withheld. */
function reportWithheld(
  fullName: string,
  remote: Pick<McpToolDefinition, "name">,
  reason: string,
  opts: RegisterMcpServerOptions,
): void {
  const info = { fullName, remoteName: String(remote.name), reason };
  if (opts.onWithhold !== undefined) opts.onWithhold(info);
  else console.warn(`[mcp] ${reason}`);
}

/**
 * A server's listing with each name kept once — the first definition, as
 * every registration path keeps it — and each later one reported through
 * `onSkip`. Registering the second would throw "already registered" part-way
 * through the list and leave the server half-registered.
 */
function firstOfEachName(
  serverName: string,
  remoteTools: ReadonlyArray<McpToolDefinition>,
  opts: RegisterMcpServerOptions,
  report: (remote: McpToolDefinition) => boolean = () => true,
): McpToolDefinition[] {
  const seen = new Set<unknown>();
  const kept: McpToolDefinition[] = [];
  for (const remote of remoteTools) {
    if (seen.has(remote.name)) {
      if (report(remote)) {
        reportSkip(
          serverName,
          remote,
          `mcp server "${serverName}" lists tool ${shownName(remote.name)} more than once; the first definition was kept and this one left out.`,
          opts,
        );
      }
      continue;
    }
    seen.add(remote.name);
    kept.push(remote);
  }
  return kept;
}

/**
 * Report a remote tool that is left out through `onSkip`, or stderr by
 * default. `fullName` is the name it would have been registered under.
 */
function reportSkip(
  serverName: string,
  remote: Pick<McpToolDefinition, "name">,
  reason: string,
  opts: RegisterMcpServerOptions,
  fullName: string = namespacedToolName(serverName, String(remote.name)),
): void {
  const remoteName = String(remote.name);
  const info = { fullName, remoteName, reason };
  if (opts.onSkip !== undefined) opts.onSkip(info);
  else console.warn(`[mcp] ${reason} The server's other tools are registered.`);
}

/** A remote tool name as a log line shows it: quoted, and cut when long. */
function shownName(name: unknown): string {
  const s = String(name);
  return JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}…` : s);
}

/**
 * Schema keywords whose value only describes: shown to the model as prose,
 * and safe to withhold. `default` and `examples` may hold any JSON; the
 * others are text.
 */
const SCHEMA_PROSE_KEYWORDS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "$comment",
  "markdownDescription",
  "default",
  "examples",
]);

/** Keywords whose value maps NAMES (property names, definition names) to schemas. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/**
 * Whether `key: value`, in a schema object, is descriptive prose: a text
 * keyword holding text, `examples` holding a list, or any `default`. A
 * property that happens to be NAMED `description` sits under `properties`,
 * which is walked as a map, so it is never mistaken for one.
 */
function isProse(key: string, value: unknown): boolean {
  if (!SCHEMA_PROSE_KEYWORDS.has(key)) return false;
  if (key === "default") return true;
  if (key === "examples") return Array.isArray(value);
  return typeof value === "string";
}

/** Every string in `value`, object keys included (bounded by the caller's depth check). */
function stringsIn(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringsIn(v, out);
    }
  }
}

/**
 * A remote tool's input schema as the model reads it — `structural`, what
 * the tool is (property names, types, enums, patterns, every other key and
 * value), and `prose`, what only describes it ({@link isProse}) — or why the
 * schema is refused before it is read: too large as JSON, nested too deep,
 * or not JSON at all. Depth is checked with an explicit stack first, so a
 * hostile nesting cannot exhaust the call stack.
 */
function schemaParts(
  schema: unknown,
): { readonly structural: string[]; readonly prose: string[] } | { readonly problem: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(schema);
  } catch (err) {
    return { problem: `its input schema cannot be read as JSON (${firstLineOf(err)})` };
  }
  const size = json?.length ?? 0;
  if (size > MAX_MCP_SCHEMA_CHARS) {
    return {
      problem: `its input schema is ${size} characters as JSON, more than the ${MAX_MCP_SCHEMA_CHARS} a tool may carry`,
    };
  }
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: schema, depth: 0 },
  ];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, depth } = next;
    if (value === null || typeof value !== "object") continue;
    if (depth >= MAX_MCP_SCHEMA_DEPTH) {
      return { problem: `its input schema nests deeper than ${MAX_MCP_SCHEMA_DEPTH} levels` };
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      stack.push({ value: item, depth: depth + 1 });
    }
  }
  const structural: string[] = [];
  const prose: string[] = [];
  const walk = (value: unknown, isMap: boolean): void => {
    if (typeof value === "string") {
      structural.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, false);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      structural.push(key);
      if (isMap) walk(item, false);
      else if (isProse(key, item)) {
        structural.pop();
        stringsIn(item, prose);
      } else walk(item, SCHEMA_MAP_KEYWORDS.has(key) && item !== null && typeof item === "object");
    }
  };
  walk(schema, false);
  return { structural, prose };
}

/** `schema` without its descriptive prose ({@link isProse}); property names are kept. */
function withoutProse(schema: unknown, isMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((item) => withoutProse(item));
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(schema)) {
    if (isMap) out[key] = withoutProse(item);
    else if (isProse(key, item)) continue;
    else {
      out[key] = withoutProse(
        item,
        SCHEMA_MAP_KEYWORDS.has(key) && item !== null && typeof item === "object",
      );
    }
  }
  return out;
}

/**
 * The registered name of the remote tool `toolName` on `serverName`:
 * `mcp__<server>__<tool>`.
 */
export function namespacedToolName(serverName: string, toolName: string): string {
  return mcpToolName(serverName, toolName);
}

/**
 * Build a single `RegisteredTool` from one remote MCP tool. Exposed so
 * tests (and any future custom-naming caller) can reuse the wiring without
 * going through `registerMcpServer`.
 *
 * `opts.registeredName` overrides the default `mcp__<server>__<tool>` catalog
 * name — the bare-name alias path (`registerMcpToolAliases`) uses it so a
 * backend flip (design §4.3) keeps one tool vocabulary. Everything else —
 * `scope: "external"`, `ioCapability: "network"`, the boundary
 * classification + lineage tagging around the remote call — is IDENTICAL
 * for aliases; only the advertised name changes.
 */
export function buildMcpRegisteredTool(
  host: McpHost,
  serverName: string,
  remote: McpToolDefinition,
  flags: {
    concurrencySafe: boolean;
    readOnly: boolean;
    destructive: boolean;
    requireJustification?: boolean;
  },
  opts: { readonly registeredName?: string } = {},
): RegisteredTool {
  if (typeof remote.name !== "string" || remote.name.length === 0) {
    throw new McpError(`mcp server "${serverName}" returned a tool with an empty/missing name`);
  }
  if (!TOOL_NAME_PATTERN.test(remote.name)) {
    throw new McpError(
      `mcp server "${serverName}" returned a tool with an invalid name "${remote.name}" (must match ${TOOL_NAME_PATTERN.source})`,
    );
  }
  const serverProblem = mcpServerNameProblem(serverName);
  if (serverProblem !== undefined) throw new McpError(serverProblem);
  const fullName = opts.registeredName ?? namespacedToolName(serverName, remote.name);
  const lengthProblem =
    opts.registeredName === undefined
      ? mcpToolNameLengthProblem(serverName, remote.name)
      : fullName.length > MAX_TOOL_NAME_LENGTH
        ? `mcp server "${serverName}" tool "${remote.name}" cannot be registered as "${fullName}": ${fullName.length} characters, and model providers accept at most ${MAX_TOOL_NAME_LENGTH}.`
        : undefined;
  if (lengthProblem !== undefined) throw new McpError(lengthProblem);
  // The size caps hold for a direct caller too. Screening the definition's
  // text needs the (async) classifier, so it runs where tools are registered:
  // a direct caller screens with `mcpToolDefinitionProblem` first.
  const schema = schemaParts(remote.inputSchema);
  if ("problem" in schema) {
    throw new McpError(
      `mcp server "${serverName}" tool ${shownName(remote.name)} cannot be registered: ${schema.problem}.`,
    );
  }
  const description = sanitizeDescription(remote.description) ?? `MCP tool ${fullName}`;
  return buildTool({
    name: fullName,
    description,
    // The MCP server validates arguments on its end. Local validator is
    // permissive so non-Zod-representable JSON Schema features round-trip.
    inputSchema: z.unknown(),
    jsonSchema: remote.inputSchema,
    concurrencySafe: flags.concurrencySafe,
    readOnly: flags.readOnly,
    destructive: flags.destructive,
    requireJustification: flags.requireJustification ?? false,
    // Pillar 3 sink-side: every MCP call is an external sink. The MCP
    // protocol gives us no visibility into what the remote server actually
    // does with its arguments — egress-classifier defaults to "external"
    // scope and treats dynamically-registered servers as
    // "external-dynamic" (strict policy) while spec-configured servers are
    // "external-configured".
    scope: "external",
    // FR-002 — declare the io-capability fact: every MCP call leaves the
    // process for a remote server over the network.
    ioCapability: "network",
    execute: async (input, ctx) => {
      const client = host.getClient(serverName);
      const args = (input ?? {}) as Record<string, unknown>;
      const result = await client.callTool(remote.name, args, {
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      // Pillar 3 boundary site — classify the FULL MCP response (not just
      // the truncated preview the §18 post-tool classifier sees later).
      // A polymorphic jailbreak hidden mid-payload would otherwise bypass
      // the runtime-core classifier when storeAndPreview truncates the
      // bytes that contained it. The boundary-classifier's content-hash
      // cache means a repeated MCP call to a healthy server doesn't burn
      // re-classification budget.
      //
      // An ERROR result (`isError`) is just as attacker-controllable and just
      // as injection-capable as a success result, so it flows through the SAME
      // classify+tag path here BEFORE being surfaced — rather than thrown raw,
      // which used to convert the unclassified, untagged attacker string into
      // an error result that reached the model's context bypassing both halves
      // of the fabric.
      const boundary = await classifyBoundary(result.content, { origin: "mcp" });
      let safeContent: string;
      if (boundary.action === "redact" && boundary.redacted !== undefined) {
        // Malicious — substitute the redaction notice. Do NOT tag lineage:
        // the raw attacker text never reaches the model's context, so there
        // is nothing for the egress fabric to track.
        safeContent = boundary.redacted;
      } else {
        safeContent = result.content;
        // Pillar 3 sink-side fabric (invariant #1) — a module that classifies
        // external content MUST also tag it so the egress check sees its
        // provenance. Record the full MCP response under origin "mcp" so the
        // egress classifier attributes any later exfiltration to the precise
        // boundary site (rather than the coarse runtime-core "tool" origin).
        // The RunContext is read from `ctx.runContext` first (#160 follow-up:
        // the runtime now threads it directly on every run) and falls back to
        // the opaque `ctx.bridge.runContext` for back-compat with callers that
        // only wire the bridge. When neither is present this best-effort tag is
        // skipped and the runtime-core post-tool path still tags the preview
        // under the coarse "tool" origin.
        const runContext = resolveRunContext(ctx);
        if (runContext !== undefined) {
          tagContent(runContext, result.content, "mcp");
        }
      }
      // An MCP error result must still surface to the model as a tool error,
      // but only AFTER classification/tagging — never the raw attacker text.
      // tool-executor wraps this McpError into an `is_error` tool result.
      if (result.isError) {
        throw new McpError(safeContent || `mcp tool "${fullName}" returned an error result`);
      }
      return safeContent;
    },
  });
}

/**
 * Connect to a registered server and register every remote tool on the
 * catalog. The host must already have the server added; this function
 * triggers `client.connect()` (idempotent) before listing tools.
 */
export async function registerMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  opts: RegisterMcpServerOptions = {},
): Promise<void> {
  const client = host.getClient(serverName);
  await client.connect();
  const remoteTools = firstOfEachName(serverName, await client.listTools(), opts);
  const budget = spentBudget(catalog, serverName);
  for (const remote of remoteTools) {
    await registerOne(host, serverName, catalog, remote, opts, budget);
  }
}

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch G, G74) — live tools/list_changed re-diff.
//
// mcp-host now surfaces a server's `notifications/tools/list_changed` via
// `McpClient.onToolsChanged`. This section closes the loop: on a change we
// re-`listTools()`, DIFF it against the last snapshot (stable schema hashing,
// mirroring the `mcp-doctor` drift watch so a mere key reorder is NOT drift),
// and apply the delta to the shared catalog — unregister removed + schema-
// changed tools, (re)register added + schema-changed ones. Steady-state
// registration (`registerMcpServer`) is unchanged; `watchMcpServer` layers the
// subscription on top so the boot path opts in with one call.
// ---------------------------------------------------------------------------

/**
 * A server's advertised tools captured for drift diffing: remote tool name →
 * stable schema hash. Built by {@link snapshotTools}; threaded across
 * `tools/list_changed` reconciles by {@link watchMcpServer}.
 */
export type McpToolSnapshot = ReadonlyMap<string, string>;

/**
 * The delta between two {@link McpToolSnapshot}s. `added`/`removed`/
 * `schemaChanged` hold REMOTE tool names (not the `mcp__<server>__`
 * namespaced form); `driftIsEmpty` is the fast steady-state check.
 */
export type McpToolDrift = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly schemaChanged: readonly string[];
};

export function driftIsEmpty(drift: McpToolDrift): boolean {
  return drift.added.length === 0 && drift.removed.length === 0 && drift.schemaChanged.length === 0;
}

/**
 * Order-insensitive canonical JSON: recursively sort object keys so a server
 * that reorders its schema keys between advertisements hashes identically
 * (that is not drift), while any real member add/remove/retype IS. Mirrors
 * `mcp-doctor`'s `canonicalJson`.
 */
function canonicalJson(value: unknown, depth = 0): string {
  // A server's schema can nest past the call stack; the snapshot must not
  // take the server's other tools down with it (see snapshotTools).
  if (depth > CANONICAL_JSON_MAX_DEPTH) throw new RangeError("schema nests too deep to hash");
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, depth + 1)}`).join(",")}}`;
}

/**
 * Past this depth a schema is not hashed. Well past the depth a schema may
 * have to register ({@link MAX_MCP_SCHEMA_DEPTH}), and well inside the call
 * stack.
 */
const CANONICAL_JSON_MAX_DEPTH = 256;

/** Stable 16-hex-char sha256 of a tool's JSON-schema. Mirrors `mcp-doctor`. */
export function hashToolSchema(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex").slice(0, 16);
}

/**
 * The snapshot hash of a tool whose schema (or annotations) cannot be hashed:
 * nested past {@link CANONICAL_JSON_MAX_DEPTH}, or not JSON. Such a tool is
 * refused when it is registered, so all that matters is that the snapshot
 * records it and that a later hashable schema reads as a change.
 */
const UNHASHABLE_SCHEMA = "unhashable";

/**
 * Build a drift snapshot (remote name → schema hash) from a live tool list.
 * A tool that carries trust hints hashes them with its schema, so a server
 * that starts calling a tool destructive mid-run has it re-registered with
 * the tighter flags. A tool without hints hashes exactly as before.
 */
export function snapshotTools(tools: ReadonlyArray<McpToolDefinition>): McpToolSnapshot {
  const map = new Map<string, string>();
  for (const t of tools) {
    // A name listed twice keeps its first definition, as registration does.
    if (map.has(t.name)) continue;
    let hash: string;
    try {
      hash = hashToolSchema(
        t.annotations === undefined
          ? t.inputSchema
          : { inputSchema: t.inputSchema, annotations: t.annotations },
      );
    } catch {
      // One tool that cannot be hashed must not stop the listing: it is
      // recorded, and registration refuses it with a reason (C100).
      hash = UNHASHABLE_SCHEMA;
    }
    map.set(t.name, hash);
  }
  return map;
}

/**
 * Diff two snapshots. `added` = in `next` not `prev`; `removed` = in `prev`
 * not `next`; `schemaChanged` = in both, different hash. An absent `prev`
 * (first observation) yields all-added, matching `mcp-doctor`'s baseline rule.
 */
export function diffToolSnapshots(
  prev: McpToolSnapshot | undefined,
  next: McpToolSnapshot,
): McpToolDrift {
  const added: string[] = [];
  const removed: string[] = [];
  const schemaChanged: string[] = [];
  const before = prev ?? new Map<string, string>();
  for (const [name, hash] of next) {
    const prevHash = before.get(name);
    if (prevHash === undefined) added.push(name);
    else if (prevHash !== hash) schemaChanged.push(name);
  }
  for (const name of before.keys()) {
    if (!next.has(name)) removed.push(name);
  }
  return { added, removed, schemaChanged };
}

/** Result of one {@link reconcileMcpServer} pass. */
export type McpReconcileResult = {
  readonly drift: McpToolDrift;
  /** The fresh snapshot — feed it back as `previous` on the next reconcile. */
  readonly snapshot: McpToolSnapshot;
};

/**
 * Re-diff a server's catalog against `previous` and apply the delta to
 * `catalog`. Forces a fresh `tools/list` (bypassing the boot cache), diffs,
 * then: unregisters removed AND schema-changed tools, and (re)registers added
 * AND schema-changed tools with the same wiring as {@link registerMcpServer}
 * (namespaced name, boundary classification, lineage tagging, resolved
 * flags). Returns the drift plus the new snapshot to thread forward. Safe when
 * nothing changed — an empty drift touches the catalog not at all. Used by
 * {@link watchMcpServer}; also callable directly (e.g. a manual re-probe).
 */
export async function reconcileMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  previous: McpToolSnapshot | undefined,
  opts: RegisterMcpServerOptions = {},
): Promise<McpReconcileResult> {
  const client = host.getClient(serverName);
  await client.connect();
  const remoteTools = await client.refreshTools();
  const snapshot = snapshotTools(remoteTools);
  const drift = diffToolSnapshots(previous, snapshot);
  // First definition of each name, as the boot listing keeps it; a repeat is
  // reported when its name is (re)registered in this pass.
  const touched = new Set([...drift.added, ...drift.schemaChanged]);
  const byName = new Map(
    firstOfEachName(serverName, remoteTools, opts, (t) => touched.has(t.name)).map(
      (t) => [t.name, t] as const,
    ),
  );

  // Removed + schema-changed leave the catalog first, so a schema-changed
  // tool can be re-registered under its (unchanged) name without tripping the
  // "already registered" guard.
  for (const remoteName of [...drift.removed, ...drift.schemaChanged]) {
    const fullName = namespacedToolName(serverName, remoteName);
    if (catalog.has(fullName)) catalog.unregister(fullName);
  }
  const budget = spentBudget(catalog, serverName);
  for (const remoteName of [...drift.added, ...drift.schemaChanged]) {
    const remote = byName.get(remoteName);
    if (remote === undefined) continue;
    await registerOne(host, serverName, catalog, remote, opts, budget);
  }
  return { drift, snapshot };
}

/** A handle from {@link watchMcpServer}: `stop()` unsubscribes from the
 *  server's `tools/list_changed` notifications (the registered tools remain). */
export type McpServerWatch = {
  readonly stop: () => void;
};

export type WatchMcpServerOptions = RegisterMcpServerOptions & {
  /** Fired after each reconcile with a NON-empty drift (diagnostics/banners). */
  readonly onDrift?: (info: { server: string; drift: McpToolDrift }) => void;
  /** Sink for a reconcile that throws (a mid-run server hiccup). Default: swallow. */
  readonly onError?: (err: unknown) => void;
};

/**
 * Register a server's tools AND keep the catalog live: subscribe to the
 * client's `tools/list_changed` and reconcile the catalog on each change. The
 * initial pass is a reconcile against an empty snapshot (registers every
 * advertised tool), so this fully replaces a bare {@link registerMcpServer}
 * call for a boot that wants drift tracking. `stop()` unsubscribes.
 *
 * A change notification's handler is synchronous (mcp-host's contract), so the
 * async reconcile is fired-and-forwarded; overlapping notifications are
 * serialised through a single in-flight chain so the snapshot never races.
 */
export async function watchMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  opts: WatchMcpServerOptions = {},
): Promise<McpServerWatch> {
  let snapshot: McpToolSnapshot | undefined;
  // Serialise reconciles: a burst of notifications chains onto the prior
  // pass rather than interleaving snapshot reads/writes.
  let chain: Promise<void> = Promise.resolve();
  const runReconcile = (): Promise<void> => {
    chain = chain.then(async () => {
      try {
        const result = await reconcileMcpServer(host, serverName, catalog, snapshot, opts);
        snapshot = result.snapshot;
        if (!driftIsEmpty(result.drift))
          opts.onDrift?.({ server: serverName, drift: result.drift });
      } catch (err) {
        opts.onError?.(err);
      }
    });
    return chain;
  };

  await runReconcile();
  const client: McpClient = host.getClient(serverName);
  const unsubscribe = client.onToolsChanged(() => {
    void runReconcile();
  });
  return { stop: unsubscribe };
}

// ---------------------------------------------------------------------------
// #406 — optional MCP peers: degrade at boot, retry in the background,
// register on arrival.
// ---------------------------------------------------------------------------

export type OptionalMcpServerOptions = WatchMcpServerOptions & {
  /** Boot/retry banner sink (the daemon's stdout writer). */
  readonly log?: (line: string) => void;
  /** Timer seams so tests drive the retry ladder without sleeping. */
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Backoff schedule; defaults to mcp-host's ladder (1 s → 30 s, jittered). */
  readonly backoffMs?: (attempt: number) => number;
  /** Background retry after a failed first attempt. Defaults to true (the
   *  daemon contract). One-shot surfaces (a cli run, a crew run, a workflow)
   *  pass false: their tool list is frozen for the process, so a peer that
   *  connects mid-run could never reach the model anyway — the honest
   *  behaviour is "absent for this run", not a retry banner mid-turn. */
  readonly retry?: boolean;
  /** Deferred config resolution + `host.addServer`, run INSIDE the
   *  never-throw boundary. An optional peer must not be able to take the
   *  boot down through ANY path — including `resolveMcpServerConfig`
   *  throwing on an unset env var (the dev machine that deliberately omits
   *  the optional peer's key). A config failure warns and gives up
   *  permanently (no retry — env vars do not appear mid-process); a connect
   *  failure follows the retry contract. When absent, the caller already
   *  added the server to the host. */
  readonly config?: () => McpServerConfig;
};

export type OptionalMcpServerHandle = {
  /** Resolves once the FIRST attempt has settled (connected or warned), so a
   *  boot sequence can log deterministically without blocking on eventual
   *  success. Never rejects. */
  readonly firstAttempt: Promise<boolean>;
  /** True once the server has connected and its tools are on the catalog. */
  connected(): boolean;
  /** Cancel the retry ladder and (when connected) stop the live re-diff.
   *  Registered tools stay on the catalog — stopping the WATCH must not
   *  yank tools out from under a running turn. */
  stop(): void;
};

/**
 * Register an OPTIONAL server: one whose absence must not stop the boot.
 *
 * The default contract stays fail-fast — a required peer that cannot connect
 * exits the daemon, because an agent whose instructions assume a tool behaves
 * worse when it silently vanishes than when it refuses to start. This is the
 * spec-opted alternative (`mcp_servers.<name>.required: false`) for the peers
 * where absence is a normal state: the A2A neighbour that boots after us —
 * two daemons that mount each other otherwise cannot both start first, which
 * turns every peer topology into a boot-order problem (and, past the
 * supervisor's restart window, into `crash-looping`).
 *
 * Behaviour:
 *   - with `opts.config`, config resolution + `host.addServer` run inside
 *     the never-throw boundary too: an unset env var WARNS and gives up
 *     permanently instead of taking the boot down (or retrying a failure
 *     that cannot heal);
 *   - the first connect attempt happens immediately; failure WARNS through
 *     `log` (naming the server and that the daemon continues without its
 *     tools) instead of throwing;
 *   - retries follow mcp-host's backoff ladder indefinitely — a peer that
 *     appears an hour later is still picked up, with no restart (unless the
 *     caller passed `retry: false`, the one-shot-surface mode);
 *   - on connect the server's tools register through {@link watchMcpServer},
 *     so the catalog additionally stays reconciled with later
 *     `tools/list_changed` notifications (the first production consumer of
 *     the G74 machinery);
 *   - which SURFACES see late-registered tools is the caller's contract:
 *     shapes that re-read the catalog per message/job (channel with an
 *     optional peer, managed, batch) advertise them on the next turn; a
 *     one-shot crew or a single long cli loop keeps its boot snapshot.
 *
 * Never throws: an optional peer must not be able to take the boot down
 * through this path at all.
 */
export function registerOptionalMcpServer(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  opts: OptionalMcpServerOptions = {},
): OptionalMcpServerHandle {
  const log = opts.log ?? (() => {});
  const setTimer =
    opts.setTimer ??
    ((cb: () => void, ms: number) => {
      const t = setTimeout(cb, ms);
      // An optional peer must never be the reason a process stays alive. A
      // pending retry keeps the event loop open, which on the shapes that
      // end by RETURNING from main() (research) would hang the process
      // forever after the work finished. unref'd, the ladder still fires
      // for as long as something else holds the loop open — which on the
      // long-lived shapes (channel daemon, batch worker) is exactly the
      // server or consumer whose lifetime the retry is meant to track.
      (t as unknown as { unref?: () => void }).unref?.();
      return t;
    });
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const backoffMs = opts.backoffMs ?? nextBackoffMs;
  const retry = opts.retry !== false;

  let stopped = false;
  let isConnected = false;
  let attempt = 0;
  let timer: unknown = null;
  let watch: McpServerWatch | undefined;
  // Config resolution is deferred into the first run when `opts.config` is
  // given; a throw there is PERMANENT (no retry) — see the option's doc.
  let added = opts.config === undefined;
  let configFailed = false;

  /** Register the connected peer's tools + banner. Returns false when the
   *  connection is up but its tool LISTING failed (see below). */
  const adopt = async (): Promise<boolean> => {
    let registered = 0;
    // `watchMcpServer` SWALLOWS a reconcile failure into `onError` — its
    // initial pass resolves even when `tools/list` failed. Treating that as
    // success would leave the peer with zero tools AND the watch disarmed
    // forever: connected in name only.
    let initialError: unknown;
    const w = await watchMcpServer(host, serverName, catalog, {
      ...opts,
      onRegister: (info) => {
        registered += 1;
        opts.onRegister?.(info);
      },
      onError: (err) => {
        // Before `isConnected` this is the INITIAL listing failing; after, a
        // mid-run drift hiccup the watch retries on its own.
        if (isConnected) {
          log(`[mcp] optional server "${serverName}" reconcile failed: ${firstLineOf(err)}\n`);
        } else {
          initialError = err;
        }
        opts.onError?.(err);
      },
    });
    if (initialError !== undefined) {
      w.stop();
      log(
        `[mcp] optional server "${serverName}" connected but its tool list failed (${firstLineOf(initialError)})\n`,
      );
      return false;
    }
    // A stop() that landed while we were connecting must not leave a live
    // subscription behind: honour it here, where the watch first exists.
    if (stopped) {
      w.stop();
      return false;
    }
    watch = w;
    isConnected = true;
    log(
      `[mcp] optional server "${serverName}" connected — ${registered} tool(s) registered` +
        `${attempt > 0 ? ` after ${attempt} check${attempt === 1 ? "" : "s"}` : ""}\n`,
    );
    return true;
  };

  const tryOnce = async (): Promise<boolean> => {
    if (!added && opts.config !== undefined) {
      try {
        host.addServer(serverName, opts.config());
        added = true;
      } catch (err) {
        configFailed = true;
        log(
          `[mcp] optional server "${serverName}" not configured (${firstLineOf(err)}) — continuing without its tools\n`,
        );
        return false;
      }
    }
    const client: McpClient = host.getClient(serverName);
    try {
      await client.connect();
    } catch (err) {
      // IMPORTANT: mcp-host owns reconnection. A failed connect that got as
      // far as opening a transport arms the client's OWN backoff ladder
      // (handleTransportClose → scheduleReconnect), which runs indefinitely
      // on REF'd timers. Two consequences drive the branches below:
      //   - a one-shot surface must CANCEL it: those timers would keep the
      //     process alive long after the run finished, and a run that is
      //     already over has no use for a reconnect;
      //   - a long-lived surface must NOT stack a second ladder on top of it
      //     (that is a doubled connect/subprocess storm). We watch instead.
      if (!retry) await client.disconnect().catch(() => {});
      const rest = retry
        ? "continuing without its tools; retrying in the background"
        : "continuing without its tools for this run";
      log(`[mcp] optional server "${serverName}" unreachable (${firstLineOf(err)}) — ${rest}\n`);
      return false;
    }
    return adopt();
  };

  /** Poll for mcp-host's OWN reconnect to land, then adopt. Deliberately does
   *  not call connect(): the client is already retrying, and a concurrent
   *  attempt would race its transport. */
  const checkLater = (): void => {
    if (stopped || !retry || configFailed) return;
    attempt += 1;
    timer = setTimer(() => {
      timer = null;
      void (async () => {
        if (stopped) return;
        let up = false;
        try {
          up = host.getClient(serverName).getState().kind === "connected";
        } catch {
          up = false;
        }
        if (up && (await adopt().catch(() => false))) return;
        checkLater();
      })();
    }, backoffMs(attempt));
  };

  const run = async (): Promise<boolean> => {
    if (stopped) return false;
    const ok = await tryOnce().catch((err) => {
      // getClient on an unregistered name, or a watch failure — still not a
      // reason an OPTIONAL peer may take the boot down.
      log(`[mcp] optional server "${serverName}" failed: ${firstLineOf(err)}\n`);
      return false;
    });
    if (!ok) checkLater();
    return ok;
  };

  const firstAttempt = run();

  return {
    firstAttempt: firstAttempt.then(
      (ok) => ok,
      () => false,
    ),
    connected: () => isConnected,
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      watch?.stop();
    },
  };
}

/** The first line of an error's message — boot banners are one line each. */
function firstLineOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? message;
}

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch G, G74) — SkillRef.tools enforcement.
//
// A skill may declare a `tools` allow-list (skills-registry's `SkillRef.tools`,
// historically parsed-but-unenforced). While that skill is ACTIVE, the model
// should see ONLY those tools. This is a pure catalog-narrowing primitive the
// runtime consumes at turn-composition time; keeping it here (next to the MCP
// registration surface) means the same narrowing covers built-ins and remote
// MCP tools alike — the model-facing name (`mcp__<server>__<tool>` for MCP,
// or its pre-0.7.1 spelling `<server>__<tool>`) is what the allow-list
// matches.
// ---------------------------------------------------------------------------

/**
 * Narrow a tool list to a skill's `tools` allow-list. When `allow` is
 * `undefined` the skill imposes NO restriction and the list passes through
 * unchanged (an empty array, by contrast, means "no tools"). Matching is by
 * the model-facing `RegisteredTool.name`, so an MCP tool is referenced by its
 * namespaced `mcp__<server>__<tool>` name — or by the `<server>__<tool>`
 * spelling a pre-0.7.1 skill used. Pure and allocation-cheap — safe to call
 * per turn.
 */
export function narrowToolsForActiveSkill(
  tools: ReadonlyArray<RegisteredTool>,
  allow: ReadonlyArray<string> | undefined,
): ReadonlyArray<RegisteredTool> {
  if (allow === undefined) return tools;
  return tools.filter((t) => allow.some((entry) => toolListEntryNames(entry, t.name)));
}

/** The spec's `tool_flags` for a server, off the config it was added with. */
function configuredFlags(host: McpHost, serverName: string): McpToolFlagsConfig | undefined {
  return host.has(serverName) ? host.getClient(serverName).toolFlags : undefined;
}

/**
 * Fold the caller's `defaults` + `perTool`, the spec's `tool_flags` and the
 * server's annotations into one flag set — see {@link RegisterMcpServerOptions}
 * for the order. The spec and the server can only tighten.
 */
export function resolveMcpToolFlags(
  opts: RegisterMcpServerOptions,
  serverName: string,
  remote: Pick<McpToolDefinition, "name" | "annotations">,
  configured: McpToolFlagsConfig | undefined,
): {
  concurrencySafe: boolean;
  readOnly: boolean;
  destructive: boolean;
  requireJustification: boolean;
} {
  const override = opts.perTool?.[remote.name] ?? {};
  // A spec's per_tool key is the server's own tool name; the registered
  // `mcp__<server>__<tool>` spelling is accepted too, since tightening by
  // either name is safe.
  const specPerTool =
    configured?.perTool?.[remote.name] ??
    configured?.perTool?.[namespacedToolName(serverName, remote.name)];
  const hints = remote.annotations;
  const destructive =
    (override.destructive ?? opts.defaults?.destructive ?? false) ||
    configured?.defaults?.destructive === true ||
    specPerTool?.destructive === true ||
    hints?.destructiveHint === true;
  const requireJustification =
    (override.requireJustification ?? opts.defaults?.requireJustification ?? false) ||
    configured?.defaults?.requireJustification === true ||
    specPerTool?.requireJustification === true;
  const readOnly =
    (override.readOnly ?? opts.defaults?.readOnly ?? false) &&
    !destructive &&
    hints?.readOnlyHint !== false;
  return {
    concurrencySafe: override.concurrencySafe ?? opts.defaults?.concurrencySafe ?? false,
    readOnly,
    destructive,
    requireJustification,
  };
}

/** The result of `registerMcpToolAliases`: which bare names landed on the
 *  catalog, and which requested aliases the server did not advertise (the
 *  caller decides whether that is a warning or an error). */
export type McpAliasRegistration = {
  readonly registered: readonly string[];
  readonly missing: readonly string[];
  /**
   * Requested aliases the server advertises but whose definition must not
   * reach the model ({@link mcpToolDefinitionProblem}): left off the catalog
   * and reported through `onSkip` (stderr by default), like a namespaced tool.
   */
  readonly refused: readonly string[];
};

/**
 * v0.3.0 Goal 3 (design §4.3) — register a SELECTED set of a server's remote
 * tools under their BARE names (no `mcp__<server>__` prefix), so a backend flip
 * keeps the exact tool vocabulary the model already knows (`wiki_recall`,
 * `goal_write`, …) while routing through the MCP client.
 *
 * Collision-guarded: a bare name already on the catalog is a composition bug
 * (e.g. the local twin was registered first) and throws `McpError` naming
 * both sides — never a silent shadow. Aliases ride the SAME
 * `buildMcpRegisteredTool` wiring as namespaced tools: `scope: "external"`,
 * `ioCapability: "network"`, boundary classification + `dataLineage` tagging
 * on every response — the Pillar 3 fabric does not care what a sink is
 * called. Requested aliases the server does not advertise are returned in
 * `missing` rather than thrown, so a caller can degrade with a warning; one
 * whose definition is refused at the boundary is returned in `refused`.
 */
export async function registerMcpToolAliases(
  host: McpHost,
  serverName: string,
  catalog: ToolCatalog,
  aliasNames: ReadonlyArray<string>,
  opts: RegisterMcpServerOptions = {},
): Promise<McpAliasRegistration> {
  const client = host.getClient(serverName);
  await client.connect();
  const listed = await client.listTools();
  const wanted = new Set(aliasNames);
  const remoteTools = firstOfEachName(serverName, listed, opts, (t) => wanted.has(t.name));
  const registered: string[] = [];
  const refused: string[] = [];
  // Aliases carry bare names, so their budget is this call's: the aliases a
  // backend flip selects are a handful of one server's tools.
  const budget: ServerBudget = { chars: 0, tools: 0 };
  for (const remote of remoteTools) {
    if (!wanted.has(remote.name)) continue;
    if (catalog.has(remote.name)) {
      throw new McpError(
        `mcp server "${serverName}" tool "${remote.name}" cannot be aliased onto its bare name — a tool named "${remote.name}" is already registered on the catalog (the local twin must not be registered when the ${serverName} backend owns the vocabulary)`,
      );
    }
    const full = budgetProblem(serverName, remote.name, budget);
    if (full !== undefined) {
      refused.push(remote.name);
      reportSkip(serverName, remote, full, opts, remote.name);
      continue;
    }
    const screened = await screenMcpToolDefinition(serverName, remote);
    if (screened.kind === "refused") {
      refused.push(remote.name);
      reportSkip(serverName, remote, screened.reason, opts, remote.name);
      continue;
    }
    const tool = buildMcpRegisteredTool(
      host,
      serverName,
      screened.definition,
      resolveMcpToolFlags(opts, serverName, remote, configuredFlags(host, serverName)),
      { registeredName: remote.name },
    );
    const overBudget = budgetProblem(serverName, remote.name, budget, tool);
    if (overBudget !== undefined) {
      refused.push(remote.name);
      reportSkip(serverName, remote, overBudget, opts, remote.name);
      continue;
    }
    if (screened.withheld !== undefined) {
      reportWithheld(remote.name, remote, screened.withheld, opts);
    }
    catalog.register(tool);
    spend(budget, tool);
    registered.push(remote.name);
    opts.onRegister?.({ fullName: tool.name, remoteName: remote.name });
  }
  const advertised = new Set(remoteTools.map((t) => t.name));
  const missing = aliasNames.filter((name) => !advertised.has(name));
  return { registered, missing, refused };
}

/**
 * Resolve the run's `RunContext` for provenance tagging. Prefers the
 * `ctx.runContext` field the runtime now threads on EVERY tool execute
 * (#160 follow-up). Falls back to the opaque runtime bridge's `runContext`
 * (Section 13) — `ToolExecuteContext.bridge` is `unknown` to tool-catalog,
 * so we read its `runContext` field structurally (rather than importing the
 * full `RuntimeBridge` from `agent-context-isolation`, which would invert the
 * dependency arrow). Returns undefined when neither is present, so the
 * boundary tag is best-effort and degrades cleanly.
 */
function resolveRunContext(ctx: ToolExecuteContext | undefined): RunContext | undefined {
  if (ctx?.runContext !== undefined) return ctx.runContext;
  const bridge = ctx?.bridge as { runContext?: RunContext } | undefined;
  return bridge?.runContext;
}

/**
 * Strip C0 control chars and trim whitespace, then cut to
 * {@link MAX_MCP_DESCRIPTION_CHARS} with a marker that says so. Anthropic's
 * API tolerates Unicode in descriptions but stripping control chars protects
 * against pathological server output. The cut never splits a surrogate pair.
 */
function sanitizeDescription(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit C0/DEL strip
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (stripped.length === 0) return undefined;
  if (stripped.length <= MAX_MCP_DESCRIPTION_CHARS) return stripped;
  const last = stripped.charCodeAt(MAX_MCP_DESCRIPTION_CHARS - 1);
  const end =
    last >= 0xd800 && last <= 0xdbff ? MAX_MCP_DESCRIPTION_CHARS - 1 : MAX_MCP_DESCRIPTION_CHARS;
  return `${stripped.slice(0, end)}… [description cut by crewhaus: ${stripped.length - end} more characters]`;
}
