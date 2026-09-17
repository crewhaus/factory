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
 * builtins are suggestible).
 *
 * EVERY builtin key must appear here: a builtin with no keywords can never be
 * suggested no matter what the instructions say, which silently shrinks the
 * catalogue this command claims to rank. `tools-cli.test.ts` asserts the key
 * set covers `CLI_RUNTIME_TOOL_KEYS` — add keywords when you add a builtin.
 */
export const TOOL_KEYWORDS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  read: ["read", "open file", "file contents", "inspect file", "cat "],
  write: ["write file", "create file", "save to", "write to disk", "generate a file"],
  edit: ["edit", "modify file", "patch", "replace in", "change the file"],
  glob: ["glob", "find files", "list files", "match files", "file pattern"],
  grep: ["grep", "search for", "search the", "find in files", "look for", "search code"],
  bash: ["bash", "shell", "run command", "execute command", "terminal", "run a script"],
  bashOutput: [
    "background command",
    "background job",
    "long-running command",
    "poll the output",
    "stream the output",
  ],
  killShell: [
    "kill the shell",
    "kill the command",
    "terminate the command",
    "stop the command",
    "cancel the command",
  ],
  todoWrite: ["todo", "task list", "track tasks", "checklist"],
  compactLog: ["compact the log", "summarize the log", "log noise", "ci log", "dedupe lines"],
  countTokens: ["count tokens", "how big is", "token count", "size of the text", "fits in context"],
  escapeString: ["escape", "quote safely", "sanitize for", "inject safely", "shell-quote"],
  extractEntities: [
    "extract urls",
    "find emails",
    "pull out ids",
    "extract entities",
    "harvest links",
  ],
  extractKeywords: ["keywords", "key terms", "tag the document", "top terms"],
  fuzzyMatch: ["fuzzy match", "closest match", "did you mean", "reconcile names", "nearest name"],
  glossaryReplace: ["glossary", "terminology", "rename terms", "house style", "replace terms"],
  markdownOutline: ["outline", "table of contents", "headings", "one section", "navigate the doc"],
  markdownTable: ["markdown table", "render a table", "format as a table", "report table"],
  normalizeText: [
    "normalize",
    "canonicalize",
    "line endings",
    "strip whitespace",
    "clean the text",
  ],
  regexExtract: [
    "regex",
    "extract with a pattern",
    "capture groups",
    "pattern match",
    "pull matches",
  ],
  renderTemplate: ["template", "fill in the placeholders", "render the message", "mail merge"],
  ruleClassify: ["classify by rules", "label the ticket", "route the message", "rule-based label"],
  sortLines: ["sort lines", "uniq", "dedupe the list", "sort the file"],
  textDiff: ["diff", "compare two", "what changed", "unified diff"],
  textSimilarity: ["similarity", "how similar", "near duplicate", "compare strings"],
  truncateToBudget: ["truncate", "fit the budget", "shorten to", "trim to size"],
  wrapText: ["wrap text", "72 columns", "quote the reply", "hard wrap"],
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

/**
 * Tools that only make sense beside a parent tool. Granting `bashOutput`
 * without `bash` is the anomaly; granting it WITH `bash` is the normal trio,
 * so flagging it as an over-grant just because the prose never said
 * "background command" is noise.
 */
export const TOOL_COMPANIONS: Readonly<Record<string, string>> = Object.freeze({
  bashOutput: "bash",
  killShell: "bash",
});

/**
 * Phrases that make the clause they appear in a REFUSAL rather than a
 * capability. "…say so if the user asks for image generation" must not read as
 * "this agent needs imageGenerate" — that false positive is worse than a
 * missed suggestion, because it is the first line of the report and the user
 * would act on it by granting a tool the instructions forbid.
 *
 * Scoping is per clause, so a keyword sharing a clause with a cue ("never
 * guess a path — read the file") is dropped too. That direction of error is
 * the cheap one: `tools suggest` under-reports instead of recommending a tool
 * the prose forbids, and any other clause asking for the tool still counts.
 */
const NEGATION_CUES: ReadonlyArray<string> = Object.freeze([
  "do not",
  "does not",
  "don't",
  "don’t",
  "doesn't",
  "doesn’t",
  "never",
  "refuse",
  "refusal",
  "decline",
  "avoid",
  "must not",
  "cannot",
  "can't",
  "can’t",
  "won't",
  "won’t",
  "should not",
  "shouldn't",
  "shouldn’t",
  "no need to",
  "without",
  "unrelated",
  "not allowed",
  "not permitted",
  "out of scope",
  "off-limits",
]);

/**
 * Word-boundary matcher for one keyword, with the common English inflections
 * so "reads"/"reading" still count. A plain `includes()` matched "read" inside
 * "already"/"spreadsheet" and "edit" inside "credit", which put tools in the
 * report that the instructions never mentioned.
 */
function keywordRegex(keyword: string): RegExp {
  const kw = keyword.trim();
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^[\w]/.test(kw) ? "\\b" : "";
  const right = /[\w]$/.test(kw) ? "(?:s|es|ed|ing)?\\b" : "";
  return new RegExp(`${left}${escaped}${right}`);
}

/**
 * Naming a tool outright is the strongest possible implication, so a
 * camelCase builtin identifier counts as its own keyword — instructions that
 * say "record the plan with `todoWrite`" or "run `codegraphImpact`" imply
 * those tools even when no prose keyword fires. Restricted to multi-word
 * identifiers: bare `write`/`fetch`/`shell` are ordinary English and would
 * re-introduce the false positives the curated lists avoid.
 */
function identityKeywords(key: string, runtimeName: string | undefined): string[] {
  if (!/[a-z][A-Z]/.test(key)) return [];
  // Reported verbatim (matching is case-insensitive) so the evidence line
  // reads "matched: codegraphImpact", the spelling the user wrote.
  const ids = [key];
  if (runtimeName !== undefined && runtimeName.toLowerCase() !== key.toLowerCase()) {
    ids.push(runtimeName);
  }
  return ids;
}

const KEYWORD_REGEX_CACHE = new Map<string, RegExp>();
/** Case-insensitive: clauses arrive lowercased, so lowercase the needle too. */
function matchesKeyword(clause: string, keyword: string): boolean {
  let re = KEYWORD_REGEX_CACHE.get(keyword);
  if (re === undefined) {
    re = keywordRegex(keyword.toLowerCase());
    KEYWORD_REGEX_CACHE.set(keyword, re);
  }
  return re.test(clause);
}

/**
 * Split instructions into clauses so a negation cue is scoped to the text it
 * negates. Instructions are usually YAML block scalars — hard-wrapped prose
 * mixed with bullet lists — so splitting on raw newlines would tear
 * "…something unrelated to the codebase (open-domain chat, image generation…"
 * in half and strand the cue in a different clause from the keyword. Unwrap
 * continuation lines first (blank lines, headings and list markers start a new
 * item), then cut on sentence ends. Exported for tests.
 */
export function splitInstructionClauses(text: string): string[] {
  const items: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      items.push(""); // hard break — the next line starts a new item
      continue;
    }
    const startsItem = /^([-*•]|\d+[.)]|#{1,6}\s)/.test(line);
    const prev = items.length > 0 ? items[items.length - 1] : undefined;
    if (startsItem || prev === undefined || prev === "") items.push(line);
    else items[items.length - 1] = `${prev} ${line}`;
  }
  const clauses: string[] = [];
  for (const item of items) {
    for (const part of item.split(/(?<=[.!?;])\s+/)) {
      const clause = part.trim();
      if (clause !== "") clauses.push(clause);
    }
  }
  return clauses;
}

function isNegated(clause: string): boolean {
  return NEGATION_CUES.some((cue) => clause.includes(cue));
}

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
  /**
   * Tools whose ONLY keyword hits sat in a refusal/negation clause. Reported
   * as evidence (an instruction that forbids a capability is a reason to drop
   * the tool, never to add it) but never suggested.
   */
  readonly negated: ReadonlyArray<ToolSuggestion>;
};

/**
 * Rank builtins against an agent's instructions. `specTools` is the spec's
 * current `tools:` list (camelCase keys, possibly empty); `toolKeys` is the
 * set of resolvable builtin keys (so a suggestion never names a tool the
 * runtime can't load). Pure and deterministic.
 *
 * Matching is literal and clause-scoped: word-boundary keyword hits, with hits
 * inside a refusal clause routed to `negated` instead of `missing`.
 */
export function suggestTools(
  instructions: string,
  specTools: ReadonlyArray<string>,
  toolKeys: ReadonlyArray<string>,
  toolMap: Readonly<Record<string, RegisteredTool>>,
): ToolSuggestResult {
  const clauses = splitInstructionClauses(instructions.toLowerCase());
  const affirmative = clauses.filter((c) => !isNegated(c));
  const refusing = clauses.filter((c) => isNegated(c));
  const present = new Set(specTools);
  const known = new Set(toolKeys);
  const missing: ToolSuggestion[] = [];
  const alreadyPresent: ToolSuggestion[] = [];
  const negated: ToolSuggestion[] = [];

  for (const [key, curated] of Object.entries(TOOL_KEYWORDS)) {
    if (!known.has(key)) continue; // never suggest an unresolvable tool
    const keywords = [...curated, ...identityKeywords(key, toolMap[key]?.name)];
    const matched = keywords.filter((kw) => affirmative.some((c) => matchesKeyword(c, kw)));
    const build = (kws: ReadonlyArray<string>): ToolSuggestion => ({
      key,
      name: toolMap[key]?.name ?? key,
      matchedKeywords: kws,
      alreadyPresent: present.has(key),
    });
    if (matched.length > 0) {
      const suggestion = build(matched);
      (suggestion.alreadyPresent ? alreadyPresent : missing).push(suggestion);
      continue;
    }
    const refused = keywords.filter((kw) => refusing.some((c) => matchesKeyword(c, kw)));
    if (refused.length > 0) negated.push(build(refused));
  }

  const rank = (a: ToolSuggestion, b: ToolSuggestion): number => {
    const diff = b.matchedKeywords.length - a.matchedKeywords.length;
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  };
  missing.sort(rank);
  alreadyPresent.sort(rank);
  negated.sort(rank);

  // Spec tools no keyword implied — possible over-grants worth reviewing. A
  // companion of a granted parent (bashOutput beside bash) is expected, not an
  // over-grant; a tool whose only mention was a refusal stays flagged, because
  // "refuse image generation" IS the argument for dropping imageGenerate.
  const impliedKeys = new Set([...missing, ...alreadyPresent].map((s) => s.key));
  const unimplied = specTools
    .filter((t) => !impliedKeys.has(t))
    .filter((t) => {
      const parent = TOOL_COMPANIONS[t];
      return parent === undefined || !present.has(parent);
    })
    .sort();

  return { missing, present: alreadyPresent, unimplied, negated };
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
  if (result.negated.length > 0) {
    lines.push("mentioned only in a refusal (NOT suggested):");
    for (const s of result.negated) {
      lines.push(
        `  − ${s.key} (${s.name}) — matched: ${s.matchedKeywords.join(", ")}${s.alreadyPresent ? " — granted in tools: though the instructions refuse it" : ""}`,
      );
    }
  }
  if (result.unimplied.length > 0) {
    lines.push(
      `in tools: but not implied by instructions (review — possible over-grant): ${result.unimplied.join(", ")}`,
    );
  }
  lines.push(
    "heuristic: literal keyword match over agent.instructions, not a model — wording it doesn't recognize won't be suggested; `crewhaus tools list` shows every builtin",
  );
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
  "bashOutput",
  "killShell",
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
  "compactLog",
  "countTokens",
  "escapeString",
  "extractEntities",
  "extractKeywords",
  "fuzzyMatch",
  "glossaryReplace",
  "markdownOutline",
  "markdownTable",
  "normalizeText",
  "regexExtract",
  "renderTemplate",
  "ruleClassify",
  "sortLines",
  "textDiff",
  "textSimilarity",
  "truncateToBudget",
  "wrapText",
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

// -------- tools categories / show / search (navigation) --------

/**
 * Navigation over the builtin catalogue. `tools list` answers "what exists";
 * these answer the three questions that follow it — how is it grouped, what
 * exactly does this one do, and which one do I want.
 *
 * All pure: the caller supplies the resolved tool map, so every function here
 * is unit-testable without touching the filesystem or importing a tool.
 */

/** One row of `tools categories`. */
export type CategoryRow = {
  readonly name: string;
  /** The selector an operator writes in a spec: `all-<name>`. */
  readonly selector: string;
  readonly title: string;
  /** Leaf categories own tools; roll-ups own other categories. */
  readonly kind: "leaf" | "roll-up";
  /** Tool keys, resolved transitively for a roll-up. */
  readonly tools: ReadonlyArray<string>;
  /** For a roll-up, the categories it rolls up. */
  readonly includes?: ReadonlyArray<string>;
};

/**
 * Build the category table. `resolve` is `toolsInCategory` from
 * `@crewhaus/tool-categories`, injected so this module stays dependency-free
 * and the test can drive a fixture registry.
 */
export function buildCategoryRows(
  categories: Readonly<
    Record<
      string,
      { title: string; tools?: ReadonlyArray<string>; includes?: ReadonlyArray<string> }
    >
  >,
  resolve: (name: string) => ReadonlyArray<string>,
): CategoryRow[] {
  return Object.entries(categories)
    .map(([name, def]) => ({
      name,
      selector: `all-${name}`,
      title: def.title,
      kind: (def.tools !== undefined ? "leaf" : "roll-up") as "leaf" | "roll-up",
      tools: resolve(name),
      ...(def.includes !== undefined ? { includes: [...def.includes] } : {}),
    }))
    .sort((a, b) => {
      // Leaves first, then roll-ups: an operator scanning for "what can I
      // turn on" wants the concrete groups before the bundles of groups.
      if (a.kind !== b.kind) return a.kind === "leaf" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** Render the category table for the terminal. */
export function formatCategoryLines(rows: ReadonlyArray<CategoryRow>): string[] {
  const lines: string[] = [];
  const leaves = rows.filter((r) => r.kind === "leaf");
  const rollUps = rows.filter((r) => r.kind === "roll-up");
  if (leaves.length > 0) {
    lines.push("categories:");
    for (const r of leaves) {
      lines.push(`  ${r.selector}  (${r.tools.length})  ${r.title}`);
      lines.push(`    ${r.tools.join(", ")}`);
    }
  }
  if (rollUps.length > 0) {
    lines.push("");
    lines.push("roll-ups:");
    for (const r of rollUps) {
      lines.push(`  ${r.selector}  (${r.tools.length})  ${r.title}`);
      lines.push(`    = ${(r.includes ?? []).map((c) => `all-${c}`).join(" + ")}`);
    }
  }
  lines.push("");
  lines.push("use in a spec:  tools: [all-fs, -write]   # a category, minus one tool");
  return lines;
}

/** Full detail for one tool — the `tools show` payload. */
export type ToolDetail = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly categories: ReadonlyArray<string>;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification: boolean;
  readonly concurrencySafe: boolean;
  /** Top-level input field names, derived from the tool's own JSON Schema. */
  readonly inputFields: ReadonlyArray<string>;
};

/**
 * Project one tool into its detail record. `key` is the camelCase spec key;
 * `categoriesFor` is `categoriesForTool`, injected for the same reason as
 * above. Returns undefined when the key names no builtin, so the caller can
 * offer suggestions rather than printing an empty record.
 */
export function buildToolDetail(
  key: string,
  toolMap: Readonly<Record<string, ToolLike>>,
  categoriesFor: (key: string) => ReadonlyArray<string>,
): ToolDetail | undefined {
  const tool = toolMap[key];
  if (tool === undefined) return undefined;
  return {
    key,
    name: tool.name,
    description: tool.description,
    categories: categoriesFor(key),
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    scope: tool.scope,
    ...(tool.ioCapability !== undefined ? { ioCapability: tool.ioCapability } : {}),
    requiresSandbox: tool.requiresSandbox,
    requireJustification: tool.requireJustification ?? false,
    concurrencySafe: tool.concurrencySafe ?? false,
    inputFields: inputFieldNames(tool),
  };
}

/**
 * The structural subset of RegisteredTool this module reads. Declared
 * locally so `tools-cli` keeps its "pure, no tool imports" property.
 */
export type ToolLike = {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification?: boolean;
  readonly concurrencySafe?: boolean;
  readonly inputSchema?: unknown;
  readonly jsonSchema?: unknown;
};

/**
 * Pull top-level input field names off a tool. Prefers the authoritative
 * `jsonSchema` when the tool carries one (MCP tools do); otherwise reads the
 * Zod schema's own `shape`, which is public API on a ZodObject. Returns an
 * empty list rather than throwing when the schema is neither — `tools show`
 * degrading to "no fields listed" beats it crashing on an exotic schema.
 */
export function inputFieldNames(tool: ToolLike): ReadonlyArray<string> {
  const fromJson = (tool.jsonSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (fromJson !== undefined && typeof fromJson === "object") {
    return Object.keys(fromJson).sort();
  }
  const shape = (tool.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  if (shape !== undefined && typeof shape === "object") {
    return Object.keys(shape).sort();
  }
  return [];
}

/** Render `tools show` for the terminal. */
export function formatToolDetailLines(d: ToolDetail): string[] {
  const flags = [
    d.readOnly ? "read-only" : "mutating",
    d.destructive ? "destructive" : undefined,
    d.scope === "external" ? "external" : "internal",
    d.ioCapability !== undefined ? `io:${d.ioCapability}` : undefined,
    d.requiresSandbox ? "sandbox-required" : undefined,
    d.requireJustification ? "justification-gated" : undefined,
    d.concurrencySafe ? "concurrency-safe" : undefined,
  ].filter((f): f is string => f !== undefined);
  return [
    `${d.key}  (${d.name})`,
    `  ${d.description}`,
    "",
    `  flags       ${flags.join(", ")}`,
    `  categories  ${d.categories.length > 0 ? d.categories.map((c) => `all-${c}`).join(", ") : "(uncategorized)"}`,
    `  input       ${d.inputFields.length > 0 ? d.inputFields.join(", ") : "(no declared fields)"}`,
    "",
    `  enable with  tools: [${d.key}]`,
  ];
}

/** One `tools search` hit, most relevant first. */
export type SearchHit = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Higher is better. Exposed so the test can pin the ranking. */
  readonly score: number;
  /** Which field matched, for the "why did this match" column. */
  readonly matchedOn: ReadonlyArray<string>;
};

/**
 * Rank builtins against a free-text query by exact/prefix/substring match on
 * the key, the PascalCase name, the description, and the tool's categories.
 * Deterministic and lexical — no model, no embeddings, same posture as
 * `tools suggest`.
 */
export function searchTools(
  query: string,
  toolMap: Readonly<Record<string, ToolLike>>,
  categoriesFor: (key: string) => ReadonlyArray<string>,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const hits: SearchHit[] = [];
  for (const [key, tool] of Object.entries(toolMap)) {
    const keyL = key.toLowerCase();
    const nameL = tool.name.toLowerCase();
    const descL = tool.description.toLowerCase();
    const cats = categoriesFor(key).map((c) => c.toLowerCase());
    let score = 0;
    const matchedOn: string[] = [];
    if (keyL === q || nameL === q) {
      score += 100;
      matchedOn.push("name");
    } else if (keyL.startsWith(q) || nameL.startsWith(q)) {
      score += 50;
      matchedOn.push("name");
    } else if (keyL.includes(q) || nameL.includes(q)) {
      score += 25;
      matchedOn.push("name");
    }
    if (cats.some((c) => c === q)) {
      score += 30;
      matchedOn.push("category");
    }
    if (descL.includes(q)) {
      score += 10;
      matchedOn.push("description");
    }
    if (score > 0)
      hits.push({ key, name: tool.name, description: tool.description, score, matchedOn });
  }
  return hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** Render `tools search` for the terminal. */
export function formatSearchLines(query: string, hits: ReadonlyArray<SearchHit>): string[] {
  if (hits.length === 0) {
    return [`no builtin tool matches "${query}" — try \`crewhaus tools categories\``];
  }
  const lines = [`${hits.length} match(es) for "${query}":`];
  for (const h of hits) {
    lines.push(`  ${h.key} (${h.name})  [${h.matchedOn.join("+")}]`);
    lines.push(`    ${h.description}`);
  }
  return lines;
}

/**
 * Suggest near-miss keys for an unknown `tools show` argument, so a typo
 * gets a pointer instead of a bare "not found".
 */
export function nearestToolKeys(
  key: string,
  known: ReadonlyArray<string>,
  limit = 3,
): ReadonlyArray<string> {
  const k = key.toLowerCase();
  return known
    .filter((candidate) => {
      const c = candidate.toLowerCase();
      return c.includes(k) || k.includes(c) || c.startsWith(k.slice(0, 3));
    })
    .slice(0, limit);
}
