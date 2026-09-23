/**
 * @crewhaus/tool-capability — `ToolRegistry`, the answer to "what exists that
 * I am not running".
 *
 * TWO QUESTIONS, ONE OF WHICH WAS ALREADY ANSWERED.
 *
 *   "What can I call right now?" is `ListTools` (`@crewhaus/runtime-core`).
 *   It reads the bound catalog, covers MCP peers that connected after boot,
 *   and is authoritative. Nothing here duplicates it.
 *
 *   "What exists in this framework that I was not given?" had no answer at
 *   all. A compiled bundle contains only the tools its spec granted, so the
 *   tools it lacks are, from inside, invisible — an agent could not name one,
 *   let alone say what it does. `ToolRegistry` reads the generated manifest in
 *   `@crewhaus/tool-registry-manifest` and reports both halves.
 *
 * THIS IS ERGONOMICS, NOT A CONTROL. Leaving a tool out of `tools:` is what
 * shapes a harness; this tool only makes the omission legible, so an operator
 * can see what the agent is missing and decide. In any harness that grants
 * bash, file write or code execution the agent can edit `crewhaus.yaml`
 * itself, so nothing here stands between an agent and a tool — and nothing in
 * its description, its output or its docs says otherwise.
 *
 * WHY ITS OWN PACKAGE. The manifest is roughly 450 KB of description text.
 * `ListTools` lives in `runtime-core`, which is in every bundle of every
 * shape, so growing it would put that text into harnesses that never asked
 * for it. `toolInventory` is the wrong axis — it reads a SPEC file, cannot
 * see MCP tools bound at connect time, and its package depends on
 * `@crewhaus/compiler`, which drags all fourteen target emitters. A separate
 * spec-granted tool makes the cost declared, which is what
 * `collectCrewhausDeps` measures anyway.
 *
 * WHAT IT READS. `granted` is computed against the LIVE catalog off
 * `ToolExecuteContext.bridge`, not against the spec — so an MCP tool
 * registered an hour after boot counts as bound, the same way `ListTools`
 * counts it. The bridge is read structurally (see `lib.ts`) so this package
 * does not depend on the sub-agent fabric.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { REGISTRY_VERSION, TOOL_REGISTRY } from "@crewhaus/tool-registry-manifest";
import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, buildRegistryAnswer, liveToolNames } from "./lib";

export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MCP_NOTE,
  type RegistryAnswer,
  type RegistryQuery,
  type RegistryRow,
  buildRegistryAnswer,
  firstSentence,
  howToRequest,
  knownCategories,
  liveToolNames,
  matchesQuery,
  normalizeCategory,
} from "./lib";

const json = (value: unknown): string => JSON.stringify(value);

export const toolRegistry: RegisteredTool = buildTool({
  name: "ToolRegistry",
  description:
    "List the builtin tools CrewHaus ships and mark which ones this harness is actually running, so you can name a tool you do not have and say what it would do. `ListTools` answers what you can call right now; this one also covers what you cannot. Search with `query`, narrow with `category` (`all-fs` or `fs`), or pass one `key` for that tool's full description. Rows you are not running come with a line on how to ask for them. It reports; it enables nothing, and a tool appears here whether or not this harness will ever have it. Builtins only: a spec declares an MCP server rather than the tools it offers, so which MCP tools exist elsewhere cannot be answered offline.",
  inputSchema: z
    .object({
      query: z
        .string()
        .optional()
        .describe("lexical search over key, name, description, category and keywords"),
      category: z
        .string()
        .optional()
        .describe('one category, written either way: "all-fs" or "fs"'),
      key: z
        .string()
        .optional()
        .describe("one tool's camelCase spec key; returns that tool with its whole description"),
      only: z
        .enum(["granted", "unlisted", "all"])
        .optional()
        .describe('"granted" = bound here, "unlisted" = exists but not bound; default "all"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`rows to return, up to ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`),
    })
    .strict(),
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  requiresSandbox: false,
  requireJustification: false,
  scope: "internal",
  execute: async (input, ctx) => {
    const answer = buildRegistryAnswer({
      registry: TOOL_REGISTRY,
      version: REGISTRY_VERSION,
      live: liveToolNames(ctx?.bridge),
      input,
    });
    if ("error" in answer) return `[ToolRegistry] ${answer.error}`;
    return json(answer);
  },
});
