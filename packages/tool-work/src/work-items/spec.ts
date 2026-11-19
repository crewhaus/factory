/**
 * What a harness's spec says about work items, read from a parsed spec document: whether
 * any of its tool lists names a Work tool (directly or through the `all-work` category,
 * exclusions applied), and its `tool_config.work` block. Pure: each head parses the spec
 * its own way and hands the document in.
 *
 * Only a property named exactly `tools` that holds a list of strings counts, wherever it
 * sits (the root, `agent:`, a step), so a `tool_config` block never reads as a tool list.
 * `tool_config.work` is read at the root and under `agent:`, the two places a block lives.
 */
import { expandToolSelectors } from "@crewhaus/tool-categories";
import { type WorkConfig, WorkConfigError, parseWorkConfig } from "./config";

/** The builtin keys of the four Work tools, as a spec lists them. */
export const WORK_TOOL_KEYS = Object.freeze([
  "workList",
  "workGet",
  "workPropose",
  "workUpdate",
] as const);

const KEYS: ReadonlySet<string> = new Set(WORK_TOOL_KEYS);

/** The deepest a spec document is walked for tool lists. */
const MAX_DEPTH = 12;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolLists(node: unknown, depth: number, out: string[][]): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) toolLists(item, depth + 1, out);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "tool_config") continue;
    if (key === "tools" && Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out.push(value as string[]);
      continue;
    }
    toolLists(value, depth + 1, out);
  }
}

/** Whether one tool list, as the compiler expands it, keeps a Work tool. */
function listKeepsWorkTool(list: readonly string[]): boolean {
  try {
    return expandToolSelectors(list).tools.some((key) => KEYS.has(key));
  } catch {
    // A list the compiler refuses builds no harness: it lists nothing.
    return false;
  }
}

export type WorkSpecFacts = {
  /** Whether any tool list keeps one of the Work tools. */
  readonly tools: boolean;
  /** The `tool_config.work` block, checked; absent when none is declared. */
  readonly config?: WorkConfig;
  /** Why the declared block was not taken, when it was refused. */
  readonly configProblem?: string;
};

/** What a parsed spec document says about work items. */
export function workSpecFacts(doc: unknown): WorkSpecFacts {
  const lists: string[][] = [];
  toolLists(doc, 0, lists);
  const tools = lists.some(listKeepsWorkTool);
  const root = isRecord(doc) ? doc : {};
  const agent = isRecord(root["agent"]) ? root["agent"] : {};
  const block = [root["tool_config"], agent["tool_config"]]
    .map((config) => (isRecord(config) ? config["work"] : undefined))
    .find((work) => work !== undefined);
  if (block === undefined) return { tools };
  try {
    return { tools, config: parseWorkConfig(block) };
  } catch (err) {
    return {
      tools,
      configProblem:
        err instanceof WorkConfigError ? err.message : "tool_config.work is unreadable",
    };
  }
}
