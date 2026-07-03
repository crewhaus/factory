/**
 * Item 18 — `crewhaus tools` namespace: builtin discovery + usage audit.
 * The pure, side-effect-free half of the tool advisor. Three sub-commands:
 *
 *   list          — every builtin's name/description/scope/ioCapability/
 *                   readOnly/destructive, from the RegisteredTool metadata
 *                   the runtime already carries.
 *   suggest <spec> — rank builtins against `agent.instructions` by a
 *                   deterministic keyword match (no model — the tool
 *                   implication is the same shape scaffold-evals uses).
 *   audit         — mine `tool_stats` + `tool_use` events across sessions
 *                   to propose (a) removing tools never called, (b) flagging
 *                   chronically failing tools, (c) learned read-only
 *                   candidates (many clean calls). ADVICE-ONLY: `tools:` is
 *                   not in OPTIMIZABLE_PATHS, so every edit is a human-review
 *                   suggestion, never an eval-gated auto-apply.
 *
 * Everything here is pure so it is unit-testable; all filesystem access
 * (loadToolMap, session reads, spec reads) lives in `apps/cli/src/index.ts`,
 * mirroring `advise-rules.ts`.
 *
 * Casing bridge (load-bearing): a spec's `tools:` list uses the camelCase
 * BUILTIN_TOOL_MAP keys (`read`, `webFetch`), but a session log's
 * `tool_stats.toolName` / `tool_use.name` carry the RegisteredTool's
 * PascalCase `.name` (`Read`, `WebFetch`). The audit correlates the two
 * through the tool map (spec key → `.name`), so a tool named in the spec is
 * matched to its runtime call stats regardless of the two casings.
 */
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { SessionEvents } from "./advise-rules";
import { payloadOf } from "./advise-rules";

// -------- tools list --------

/** One row of `tools list`, projected from a RegisteredTool. */
export type ToolListRow = {
  /** The camelCase spec/map key (what a user writes in `tools:`). */
  readonly key: string;
  /** The RegisteredTool's PascalCase `.name` (what session logs record). */
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
};

/** Project a tool map (key → RegisteredTool) into sorted list rows. */
export function buildToolList(toolMap: Readonly<Record<string, RegisteredTool>>): ToolListRow[] {
  return Object.entries(toolMap)
    .map(([key, t]) => ({
      key,
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      destructive: t.destructive,
      scope: t.scope,
      ...(t.ioCapability !== undefined ? { ioCapability: t.ioCapability } : {}),
      requiresSandbox: t.requiresSandbox,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** One line per tool for the CLI's text mode. */
export function formatToolListLines(rows: ReadonlyArray<ToolListRow>): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    const flags = [
      r.readOnly ? "read-only" : undefined,
      r.destructive ? "destructive" : undefined,
      r.scope === "external" ? "external" : undefined,
      r.ioCapability !== undefined ? `io:${r.ioCapability}` : undefined,
      r.requiresSandbox ? "sandbox" : undefined,
    ].filter((f): f is string => f !== undefined);
    const tags = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    lines.push(`${r.key} (${r.name})${tags}`);
    lines.push(`  ${r.description}`);
  }
  return lines;
}

// -------- tools suggest --------

/**
 * Deterministic keyword → tool implication. Each tool key maps to the
 * lowercased keywords whose presence in an agent's instructions implies the
 * tool is likely wanted. Kept intentionally small and obvious (no model, no
 * fuzzy match) — the same posture scaffold-evals uses when it derives
 * `expected_tools` from a task. Unknown/custom tools never appear here (only
 * builtins are suggestible); a builtin with no keywords is never suggested.
 */
export const TOOL_KEYWORDS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  read: ["read", "open file", "file contents", "inspect file", "cat "],
  write: ["write file", "create file", "save to", "write to disk", "generate a file"],
  edit: ["edit", "modify file", "patch", "replace in", "change the file"],
  glob: ["glob", "find files", "list files", "match files", "file pattern"],
  grep: ["grep", "search for", "search the", "find in files", "look for", "search code"],
  bash: ["bash", "shell", "run command", "execute command", "terminal", "run a script"],
  todoWrite: ["todo", "task list", "track tasks", "checklist"],
  webFetch: ["fetch url", "fetch a url", "webpage", "web page", "http get", "download page"],
  webSearch: ["web search", "search the web", "search online", "look up online", "google"],
  readImage: ["image", "screenshot", "read an image", "vision", "picture"],
  fetch: ["fetch", "api call", "rest api", "http request", "call an endpoint"],
  python: ["python", "run python", "data analysis", "numpy", "pandas"],
  javascript: ["javascript", "run javascript", "node script", "eval js"],
  shell: ["shell command", "sh -c", "posix shell"],
  imageGenerate: ["generate image", "create image", "dall-e", "image generation", "draw"],
  ingestDocument: ["ingest", "parse document", "read document", "pdf", "docx", "extract text"],
  codegraphSearch: ["codegraph", "code search", "symbol search", "find symbol"],
  codegraphCallers: ["callers of", "who calls", "find callers"],
  codegraphCallees: ["callees", "what does it call", "find callees"],
  codegraphImpact: ["impact analysis", "blast radius", "affected by"],
});

export type ToolSuggestion = {
  readonly key: string;
  readonly name: string;
  /** The instruction keywords that implied this tool. */
  readonly matchedKeywords: ReadonlyArray<string>;
  /** True when the spec already lists this tool (already-satisfied). */
  readonly alreadyPresent: boolean;
};

export type ToolSuggestResult = {
  /** Implied-but-missing tools, ranked by keyword-hit count then key. */
  readonly missing: ReadonlyArray<ToolSuggestion>;
  /** Implied tools already in the spec (reported for confidence). */
  readonly present: ReadonlyArray<ToolSuggestion>;
  /** Tools in the spec that no keyword implied (candidate over-grants). */
  readonly unimplied: ReadonlyArray<string>;
};

/**
 * Rank builtins against an agent's instructions. `specTools` is the spec's
 * current `tools:` list (camelCase keys, possibly empty); `toolKeys` is the
 * set of resolvable builtin keys (so a suggestion never names a tool the
 * runtime can't load). Pure and deterministic.
 */
export function suggestTools(
  instructions: string,
  specTools: ReadonlyArray<string>,
  toolKeys: ReadonlyArray<string>,
  toolMap: Readonly<Record<string, RegisteredTool>>,
): ToolSuggestResult {
  const haystack = instructions.toLowerCase();
  const present = new Set(specTools);
  const known = new Set(toolKeys);
  const missing: ToolSuggestion[] = [];
  const alreadyPresent: ToolSuggestion[] = [];

  for (const [key, keywords] of Object.entries(TOOL_KEYWORDS)) {
    if (!known.has(key)) continue; // never suggest an unresolvable tool
    const matched = keywords.filter((kw) => haystack.includes(kw));
    if (matched.length === 0) continue;
    const suggestion: ToolSuggestion = {
      key,
      name: toolMap[key]?.name ?? key,
      matchedKeywords: matched,
      alreadyPresent: present.has(key),
    };
    (suggestion.alreadyPresent ? alreadyPresent : missing).push(suggestion);
  }

  const rank = (a: ToolSuggestion, b: ToolSuggestion): number => {
    const diff = b.matchedKeywords.length - a.matchedKeywords.length;
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  };
  missing.sort(rank);
  alreadyPresent.sort(rank);

  // Spec tools no keyword implied — possible over-grants worth reviewing.
  const impliedKeys = new Set([...missing, ...alreadyPresent].map((s) => s.key));
  const unimplied = specTools.filter((t) => !impliedKeys.has(t)).sort();

  return { missing, present: alreadyPresent, unimplied };
}

export function formatSuggestLines(result: ToolSuggestResult): string[] {
  const lines: string[] = [];
  if (result.missing.length === 0) {
    lines.push("no additional builtins implied by the instructions");
  } else {
    lines.push("implied but not in tools:");
    for (const s of result.missing) {
      lines.push(`  + ${s.key} (${s.name}) — matched: ${s.matchedKeywords.join(", ")}`);
    }
  }
  if (result.present.length > 0) {
    lines.push("implied and already present:");
    for (const s of result.present) {
      lines.push(`  · ${s.key} — matched: ${s.matchedKeywords.join(", ")}`);
    }
  }
  if (result.unimplied.length > 0) {
    lines.push(
      `in tools: but not implied by instructions (review — possible over-grant): ${result.unimplied.join(", ")}`,
    );
  }
  return lines;
}

// -------- tools audit --------

/** Per-tool aggregate over a session set's `tool_stats` lines, keyed by the
 *  PascalCase runtime `.name`. */
export type ToolUsageStats = {
  calls: number;
  errors: number;
  totalDurationMs: number;
};

/**
 * Fold session events into per-tool usage stats. Reads `tool_stats` lines
 * (the durable per-call mirror); tolerant of old-vintage logs (no such
 * lines → empty map). Keyed by `toolName` exactly as recorded (PascalCase).
 */
export function buildToolUsage(
  sessions: ReadonlyArray<SessionEvents>,
): ReadonlyMap<string, ToolUsageStats> {
  const usage = new Map<string, ToolUsageStats>();
  for (const session of sessions) {
    for (const obj of session.objects) {
      const stats = payloadOf(obj, "tool_stats");
      if (stats === undefined || typeof stats["toolName"] !== "string") continue;
      const s = usage.get(stats["toolName"]) ?? { calls: 0, errors: 0, totalDurationMs: 0 };
      s.calls += 1;
      if (stats["isError"] === true) s.errors += 1;
      if (typeof stats["durationMs"] === "number") s.totalDurationMs += stats["durationMs"];
      usage.set(stats["toolName"], s);
    }
  }
  return usage;
}

export type AuditThresholds = {
  /** Tools with ≥ this many calls whose error rate crosses `failRate` are flagged. */
  readonly failMinCalls: number;
  readonly failRate: number;
  /** Clean (error-free) calls at/above which a non-readOnly tool is a
   *  learned-readOnly candidate. */
  readonly readOnlyMinCleanCalls: number;
};

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = Object.freeze({
  failMinCalls: 5,
  failRate: 0.5,
  readOnlyMinCleanCalls: 10,
});

export type ToolAuditFinding =
  /** A tool granted in the spec but never called across the mined sessions. */
  | { readonly kind: "unused"; readonly key: string; readonly name: string }
  /** A granted tool whose error rate crosses the threshold. */
  | {
      readonly kind: "failing";
      readonly key: string;
      readonly name: string;
      readonly calls: number;
      readonly errors: number;
      readonly rate: number;
    }
  /** A non-readOnly tool with many clean calls — candidate readOnly reclassify. */
  | {
      readonly kind: "learned-read-only";
      readonly key: string;
      readonly name: string;
      readonly calls: number;
    };

export type ToolAuditResult = {
  readonly sessionIds: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<ToolAuditFinding>;
};

/**
 * Audit a spec's granted tools against observed usage. Pure.
 *
 *   - `specTools`: the spec's `tools:` list (camelCase keys). When the spec
 *     grants NO explicit list (empty), the "unused" check is skipped — an
 *     agent with the default toolset shouldn't be told to remove tools it
 *     never declared.
 *   - `usage`: `buildToolUsage` output (PascalCase-keyed).
 *   - `toolMap`: resolves a spec key → RegisteredTool (for `.name` +
 *     `readOnly`), bridging the two casings.
 *
 * Findings are advice-only (`tools:` is not optimizer-whitelisted).
 */
export function auditTools(opts: {
  readonly sessions: ReadonlyArray<SessionEvents>;
  readonly specTools: ReadonlyArray<string>;
  readonly usage: ReadonlyMap<string, ToolUsageStats>;
  readonly toolMap: Readonly<Record<string, RegisteredTool>>;
  readonly hasExplicitToolList: boolean;
  readonly thresholds?: Partial<AuditThresholds>;
}): ToolAuditResult {
  const t: AuditThresholds = { ...DEFAULT_AUDIT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const findings: ToolAuditFinding[] = [];

  // Index usage by the RegisteredTool `.name` (already the usage key) and
  // build a spec-key → name resolver.
  const nameFor = (key: string): string => opts.toolMap[key]?.name ?? key;

  // (a) unused grants — only when the spec declared an explicit list.
  if (opts.hasExplicitToolList) {
    for (const key of opts.specTools) {
      const name = nameFor(key);
      const stats = opts.usage.get(name);
      if (stats === undefined || stats.calls === 0) {
        findings.push({ kind: "unused", key, name });
      }
    }
  }

  // (b) chronically failing tools — over ALL observed tools, mapped back to a
  //     spec key when we can (falls back to the runtime name otherwise).
  const nameToKey = new Map<string, string>();
  for (const [key, tool] of Object.entries(opts.toolMap)) nameToKey.set(tool.name, key);
  for (const [name, stats] of opts.usage) {
    if (stats.calls < t.failMinCalls) continue;
    const rate = stats.errors / stats.calls;
    if (rate < t.failRate) continue;
    findings.push({
      kind: "failing",
      key: nameToKey.get(name) ?? name,
      name,
      calls: stats.calls,
      errors: stats.errors,
      rate,
    });
  }

  // (c) learned read-only candidates — a tool NOT declared readOnly that has
  //     many error-free calls. Signals it may be safe to reclassify (which
  //     would let the permission engine auto-allow it in auto mode).
  for (const [name, stats] of opts.usage) {
    if (stats.errors > 0) continue;
    if (stats.calls < t.readOnlyMinCleanCalls) continue;
    const key = nameToKey.get(name);
    if (key === undefined) continue; // an unmapped runtime name — can't propose a spec-key edit
    const tool = opts.toolMap[key];
    if (tool === undefined || tool.readOnly) continue; // already read-only → nothing to learn
    findings.push({ kind: "learned-read-only", key, name, calls: stats.calls });
  }

  // Deterministic order: unused, then failing (worst rate first), then
  // learned-read-only, each alphabetized within its group.
  const groupRank = (f: ToolAuditFinding): number =>
    f.kind === "unused" ? 0 : f.kind === "failing" ? 1 : 2;
  findings.sort((a, b) => {
    const g = groupRank(a) - groupRank(b);
    if (g !== 0) return g;
    if (a.kind === "failing" && b.kind === "failing") {
      const d = b.rate - a.rate;
      if (d !== 0) return d;
    }
    return a.key.localeCompare(b.key);
  });

  return { sessionIds: opts.sessions.map((s) => s.sessionId), findings };
}

export function formatAuditLines(result: ToolAuditResult): string[] {
  const lines: string[] = [];
  if (result.findings.length === 0) {
    lines.push("no tool-usage findings — grants look well-matched to observed calls");
    return lines;
  }
  for (const f of result.findings) {
    switch (f.kind) {
      case "unused":
        lines.push(
          `[remove?] ${f.key} (${f.name}) — granted but never called in the mined sessions; drop it from tools: unless it's for a path these sessions didn't exercise`,
        );
        break;
      case "failing":
        lines.push(
          `[failing] ${f.key} (${f.name}) — ${f.errors}/${f.calls} calls errored (${(f.rate * 100).toFixed(0)}%); investigate inputs/backend or swap the tool`,
        );
        break;
      case "learned-read-only":
        lines.push(
          `[read-only?] ${f.key} (${f.name}) — ${f.calls} clean calls, 0 errors; if it never mutates, mark it readOnly so auto mode can auto-allow it`,
        );
        break;
    }
  }
  return lines;
}

// -------- map-sync guard --------

/**
 * The canonical set of built-in tool KEYS the CLI runtime can resolve at
 * `crewhaus run` time — the exact key set of `loadToolMap()` in
 * `apps/cli/src/index.ts`. It MUST equal `BUILTIN_TOOL_MAP`'s keys in
 * `packages/target-cli/src/index.ts`: that map decides which `tools:` names
 * COMPILE, this one decides which RUN, and a name in one but not the other is
 * a latent break (compiles then crashes, or runs a name the emitter rejects).
 * The sync test in `tools-cli.test.ts` asserts the two are equal; `loadToolMap`
 * is built to cover exactly these keys.
 */
export const CLI_RUNTIME_TOOL_KEYS: ReadonlyArray<string> = Object.freeze([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "todoWrite",
  "webFetch",
  "webSearch",
  "readImage",
  "fetch",
  "python",
  "javascript",
  "shell",
  "imageGenerate",
  "ingestDocument",
  "codegraphSearch",
  "codegraphCallers",
  "codegraphCallees",
  "codegraphImpact",
]);

/**
 * Compare two tool-name key sets. Returns the symmetric difference so the
 * sync test can report exactly which names drifted. Empty arrays ⇒ in sync.
 */
export function diffToolMapKeys(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): { readonly onlyInA: ReadonlyArray<string>; readonly onlyInB: ReadonlyArray<string> } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: [...setA].filter((k) => !setB.has(k)).sort(),
    onlyInB: [...setB].filter((k) => !setA.has(k)).sort(),
  };
}
