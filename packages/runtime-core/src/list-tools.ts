/**
 * #405 — `ListTools`, the runtime's own toolset-introspection tool.
 *
 * The failure it exists for: a long-running session began on a build where
 * certain tools were absent, and the agent (correctly, then) enumerated its
 * toolset into the conversation. The daemon was rebuilt with the tools added
 * and the session resumed — with the NEW definitions attached to every
 * request — yet the agent kept insisting the tools were not in its schema,
 * reproducing its own earlier enumeration as if freshly scanned and refusing
 * to "fabricate" calls to tools it believed absent. The transcript prior beat
 * the live schema, and no amount of arguing helped, because an operator's
 * assertion is exactly as much hearsay as the transcript.
 *
 * A tool_result is not hearsay. `ListTools` returns the runtime's ACTUAL
 * advertised toolset — the same list attached to this very request — so its
 * output enters the transcript as runtime truth, which is the kind of
 * evidence that overrides a stale in-transcript enumeration. It also gives
 * operators a one-line remedy for the deadlock ("call ListTools") instead of
 * deleting session history.
 *
 * Named in the runtime-bookkeeping family (`Skill`, `FocusRead`, `GoalList`,
 * …) and allowed by {@link BUILTIN_BOOKKEEPING_RULES} for the same reason
 * they are: under `permissionMode: "default"` an unruled tool falls back to
 * `ask`, and an introspection tool that PARKS on approval in a headless
 * daemon is useless for exactly the deadlock it exists to break.
 *
 * The name list is LATE-BOUND: the tool is built before the final advertised
 * list exists (it is itself part of that list), so the provider is a thunk
 * resolved at call time.
 */
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

export const LIST_TOOLS_NAME = "ListTools";

/** One advertised tool, as `ListTools` reports it. */
export type AdvertisedToolSummary = {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  /** The tool carries the Pillar 3 justification gate. */
  readonly gated: boolean;
};

/**
 * Render the report. One line per tool, sorted by name, with a header that
 * states WHAT this list is — the set advertised on the current request —
 * because that provenance claim is the entire point.
 */
export function renderToolList(tools: ReadonlyArray<AdvertisedToolSummary>): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    `This is the runtime's live toolset — the ${sorted.length} tool(s) advertised on THIS request. ` +
      "It is read from the bound tool catalog, not from conversation history; " +
      "if the conversation says otherwise, the conversation is stale.",
    "",
  ];
  for (const t of sorted) {
    const flags = [
      ...(t.readOnly ? ["read-only"] : []),
      ...(t.destructive ? ["destructive"] : []),
      ...(t.gated ? ["requires justification"] : []),
    ];
    const firstSentence = t.description.split(/(?<=[.!?])\s/)[0] ?? t.description;
    lines.push(`- ${t.name}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""} — ${firstSentence}`);
  }
  return lines.join("\n");
}

/**
 * Build the `ListTools` tool over a late-bound provider of the CURRENT
 * advertised list. Read-only, side-effect-free, safe to call repeatedly.
 */
export function buildListToolsTool(
  currentTools: () => ReadonlyArray<AdvertisedToolSummary>,
): RegisteredTool {
  return {
    name: LIST_TOOLS_NAME,
    description:
      "List the toolset actually bound to this runtime right now — the authoritative answer to " +
      '"which tools do I have?". Call this whenever the conversation and the tool schema seem to ' +
      "disagree about available tools (for example after a resume): the result is runtime truth " +
      "and overrides any earlier in-conversation enumeration.",
    inputSchema: z.object({}).strict(),
    execute: async () => renderToolList(currentTools()),
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    requiresSandbox: false,
    requireJustification: false,
    classifyOutput: true,
    scope: "internal",
  };
}
