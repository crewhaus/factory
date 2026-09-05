/**
 * `buildAdvertisement` (§4.4, §5) — the SUBSET-ONLY per-candidate toolset.
 *
 * Composition order for a candidate: shape tools → profile subset →
 * capability filter. A profile's `tools:` can only REMOVE tools from the
 * shape's set, never add one (a name that matches nothing is reported, not
 * invented), and a tool whose `requiresModelFeatures` the candidate cannot
 * satisfy is dropped even when the profile names it. `tools: []` means zero
 * SHAPE tools — the auto-registered loop tools the caller lists in `retain`
 * (Skill / ListTools / Task / continuity / memory) survive unless the
 * profile's `permissions.deny` removes them, because a judge profile that
 * could not call `ListTools` would deadlock headless runs (§5.2).
 *
 * The advertisement is a subset in the ADVERTISEMENT only; the dispatch
 * gate that makes it a subset in EXECUTION lives in runtime-core (§4.4 item
 * 3) and reads the same `names` set this returns.
 */
import type { ProviderFeatures } from "@crewhaus/adapter-anthropic";
import type { CandidateCapabilities, FeatureRequirement, ModelProfile } from "./types.js";

/** The minimum a tool must carry to be advertised — `RegisteredTool` satisfies it. */
export type AdvertisableTool = {
  readonly name: string;
  readonly requiresModelFeatures?: FeatureRequirement;
};

export type AdvertisementExclusion = {
  readonly name: string;
  readonly reason: "not-in-profile" | "requires-feature" | "denied";
  /** The unmet requirement key for `requires-feature`. */
  readonly detail?: string;
};

export type Advertisement<T extends AdvertisableTool> = {
  /** The tools to advertise, in the shape's declared order. */
  readonly tools: readonly T[];
  /** `tools.map(t => t.name)` as a set — the dispatch gate's allow list. */
  readonly names: ReadonlySet<string>;
  readonly excluded: readonly AdvertisementExclusion[];
  /** Profile `tools:` entries that matched no shape tool — never additive, so they are reported. */
  readonly unmatched: readonly string[];
};

export type BuildAdvertisementOptions = {
  /** What the candidate can do; a tool requiring an unknown feature is dropped. */
  readonly capabilities?: CandidateCapabilities;
  /** Auto-registered loop tool names that survive `tools: []` (but not a deny). */
  readonly retain?: readonly string[];
};

export function buildAdvertisement<T extends AdvertisableTool>(
  tools: readonly T[],
  profile: Pick<ModelProfile, "tools" | "permissions">,
  opts: BuildAdvertisementOptions = {},
): Advertisement<T> {
  const retain = new Set(opts.retain ?? []);
  const denied = denyMatchers(profile.permissions?.deny ?? []);
  const excluded: AdvertisementExclusion[] = [];
  const kept: T[] = [];
  const matchedPatterns = new Set<string>();

  for (const tool of tools) {
    if (denied.some((m) => m(tool.name))) {
      excluded.push({ name: tool.name, reason: "denied" });
      continue;
    }
    if (profile.tools !== undefined && !retain.has(tool.name)) {
      const hit = profile.tools.find((pattern) => matchesToolPattern(pattern, tool.name));
      if (hit === undefined) {
        excluded.push({ name: tool.name, reason: "not-in-profile" });
        continue;
      }
      matchedPatterns.add(hit);
    }
    const unmet = unmetRequirement(tool.requiresModelFeatures, opts.capabilities);
    if (unmet !== undefined) {
      excluded.push({ name: tool.name, reason: "requires-feature", detail: unmet });
      continue;
    }
    kept.push(tool);
  }

  const unmatched = (profile.tools ?? []).filter((pattern) => {
    if (matchedPatterns.has(pattern)) return false;
    // A pattern that only matched denied tools is still "matched" for the
    // purpose of the never-additive report — the deny is the reason.
    return !tools.some((t) => matchesToolPattern(pattern, t.name));
  });

  return {
    tools: kept,
    names: new Set(kept.map((t) => t.name)),
    excluded,
    unmatched,
  };
}

/**
 * Does a candidate's known capability set satisfy a requirement? Mirrors
 * `@crewhaus/cost-tracker`'s `satisfiesCapabilities` (the offline twin) over
 * the runtime `adapter.features`: `true` booleans are required, `caching:
 * "automatic"` accepts explicit or automatic, size floors need a KNOWN value
 * `>=` the floor. Unknown features (no adapter yet) satisfy nothing that is
 * required — never over-promise. Returns the first unmet key, or `undefined`
 * when satisfied.
 */
export function unmetRequirement(
  req: FeatureRequirement | undefined,
  caps: CandidateCapabilities | undefined,
): string | undefined {
  if (req === undefined) return undefined;
  const features = caps?.features;
  for (const key of ["tool_use", "vision", "thinking", "web_search"] as const) {
    if (req[key] === true && features?.[key] !== true) return key;
  }
  if (req.caching === "explicit" && features?.caching !== "explicit") return "caching";
  if (req.caching === "automatic" && (features === undefined || features.caching === false)) {
    return "caching";
  }
  if (
    req.contextWindowGte !== undefined &&
    (caps?.contextWindow === undefined || caps.contextWindow < req.contextWindowGte)
  ) {
    return "contextWindowGte";
  }
  if (
    req.maxOutputTokensGte !== undefined &&
    (caps?.maxOutputTokens === undefined || caps.maxOutputTokens < req.maxOutputTokensGte)
  ) {
    return "maxOutputTokensGte";
  }
  return undefined;
}

/** Convenience twin of `unmetRequirement` for callers that only hold `features`. */
export function satisfiesFeatures(
  features: ProviderFeatures | undefined,
  req: FeatureRequirement | undefined,
): boolean {
  return unmetRequirement(req, features === undefined ? undefined : { features }) === undefined;
}

/**
 * A profile `tools:` entry matches a tool name exactly, as the SPEC spelling
 * of a builtin key, or as a glob whose only wildcard is `*` (one or more,
 * matching any run of characters). The MCP convention `mcp__<server>__*` is
 * the intended glob shape; the compile-time validator checks the shape, this
 * matches it at connect time.
 *
 * The spec-spelling rule (0.6.0 PR 7 ruled that candidate `tools` keep the
 * spec's builtin keys — `read`, `webFetch`, `codegraphSearch` — rather than
 * being renamed at lower time): every builtin key in codegen's
 * `BUILTIN_TOOL_MAP` is its `RegisteredTool.name` with a different case
 * (`read` → `Read`, `webFetch` → `WebFetch`, `javascript` → `JavaScript`,
 * `codegraphSearch` → `CodeGraphSearch`), so a literal pattern matches
 * case-insensitively. Tool names are unique per catalog regardless of case,
 * so this cannot make one pattern match two tools.
 */
export function matchesToolPattern(pattern: string, name: string): boolean {
  if (!pattern.includes("*"))
    return pattern === name || pattern.toLowerCase() === name.toLowerCase();
  return globToRegExp(pattern).test(name);
}

/** The spec keys whose `tool_config` block every code-execution tool shares. */
const CODE_EXECUTION_CONFIG_ALIASES = ["codeExecution", "code_execution"] as const;
const CODE_EXECUTION_TOOL_NAMES = new Set(["python", "javascript", "shell"]);

/**
 * 0.6.0 §4.4 — the per-candidate `tool_config` block that applies to ONE
 * tool: the entry keyed by the tool's registered name, else by its spec
 * spelling (the same case-insensitive rule `matchesToolPattern` applies),
 * else — for the code-execution family (`Python` / `JavaScript` / `Shell`)
 * — the shared `codeExecution` / `code_execution` alias codegen's
 * `resolveTools` honours for the boot-time registration. `undefined` when
 * the candidate declares nothing for the tool, so the tool reads its
 * registered config as before.
 */
export function toolConfigFor(
  toolConfigs: Readonly<Record<string, unknown>> | undefined,
  toolName: string,
): unknown {
  if (toolConfigs === undefined) return undefined;
  if (toolConfigs[toolName] !== undefined) return toolConfigs[toolName];
  const lower = toolName.toLowerCase();
  for (const [key, value] of Object.entries(toolConfigs)) {
    if (key.toLowerCase() === lower && value !== undefined) return value;
  }
  if (CODE_EXECUTION_TOOL_NAMES.has(lower)) {
    for (const alias of CODE_EXECUTION_CONFIG_ALIASES) {
      if (toolConfigs[alias] !== undefined) return toolConfigs[alias];
    }
  }
  return undefined;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Deny rules in the permission grammar (`Bash(*)`, `Edit(*)`, a bare name)
 * name a tool before the optional `(...)` argument matcher; the
 * advertisement only needs the tool-name half, so `Bash(*)` and `Bash`
 * both remove `Bash` while `Bash(rm *)` — an argument-scoped deny — does
 * NOT remove the tool (the permission engine still refuses that argument).
 */
function denyMatchers(deny: readonly string[]): ReadonlyArray<(name: string) => boolean> {
  const out: Array<(name: string) => boolean> = [];
  for (const rule of deny) {
    const open = rule.indexOf("(");
    if (open === -1) {
      out.push((name) => matchesToolPattern(rule, name));
      continue;
    }
    const toolPart = rule.slice(0, open);
    const argPart = rule.slice(open + 1, rule.lastIndexOf(")"));
    if (argPart.trim() === "*" || argPart.trim() === "") {
      out.push((name) => matchesToolPattern(toolPart, name));
    }
  }
  return out;
}
