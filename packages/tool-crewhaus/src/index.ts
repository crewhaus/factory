/**
 * @crewhaus/tool-crewhaus — CrewHaus's own operations, as deterministic tools.
 *
 * These are the calls a MANAGER harness makes about the harnesses it
 * supervises: is this spec valid, will it compile, what does it grant, what
 * changed since yesterday, is its bundle stale, did its eval hold the line,
 * what did it cost, is its audit chain intact. Every one of them is a
 * question with a right answer, so none of them needs a model turn.
 *
 * Four properties hold across the package:
 *
 *   1. THE REAL LIBRARIES. Nothing here shells out to the `crewhaus` CLI and
 *      nothing re-implements it: specs go through `@crewhaus/spec`, compiles
 *      through `@crewhaus/compiler`, preflight through `@crewhaus/preflight`,
 *      chain verification through `@crewhaus/audit-log`. A tool here cannot
 *      drift from the product because it IS the product's code.
 *   2. CONTAINMENT. Every caller-supplied path goes through `resolveSafe`
 *      (copied from `@crewhaus/tool-fsx`), which refuses anything resolving
 *      outside `process.cwd()`, including via a symlink inside the workspace.
 *   3. NO AMBIENT ENVIRONMENT. `PreflightRun` takes its environment as an
 *      argument. It never reads `process.env`, because the environment a
 *      supervisor must check is the one the SPAWN would receive — the
 *      harness's own `.env` chain under the manager's env — not whatever the
 *      manager happens to have exported.
 *   4. DETERMINISM. Listings are sorted with plain string comparison (never
 *      `localeCompare`), timestamps in results come from the data rather than
 *      the clock, and the one place a clock can enter — the compiler's
 *      model-sunset check — is exposed as an explicit `today` input.
 *
 * WHAT THESE TOOLS DO NOT DO. They never start, stop or mutate a harness;
 * every tool here is read-only. They never reach a provider, so "will this
 * compile" is not "will this run" — credentials, rate limits and model
 * availability are live facts no offline check can answer. And they read a
 * harness's declared configuration, which is not always the configuration it
 * is running: a stale bundle is precisely the case where the two differ,
 * which is why `BundleFreshness` exists.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { type VerifyResult, verify as verifyAuditChain } from "@crewhaus/audit-log";
import { type CompileWarning, compile, expandSpecToolCategories } from "@crewhaus/compiler";
import {
  type PreflightItem,
  collectSpecModels,
  compareBundleFreshnessByMtime,
  runPreflight,
} from "@crewhaus/preflight";
import { type Spec, parseSpec, parseSpecIssues } from "@crewhaus/spec";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { HARNESS_SPEC_FILENAME, discoverHarnesses } from "./discover";
import {
  type EvalGateThresholds,
  type EvalRunView,
  compareEvalRuns,
  readEvalRun,
} from "./lib/eval-gate";
import { readSpecIdentity } from "./lib/identity";
import { auditPermissions, toRegisteredName } from "./lib/permissions";
import {
  type SessionEvent,
  filterEvents,
  parseSessionLog,
  summarizeCost,
  summarizeEvents,
} from "./lib/sessions";
import {
  type SpecView,
  asRecord,
  buildSpecView,
  compareStrings,
  diffSpecViews,
} from "./lib/spec-view";
import { type SafePath, ToolPermissionError, renderPath, resolveSafe, toPosix } from "./paths";

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

/** A spec is YAML a human wrote; anything past this is not one. */
const MAX_SPEC_BYTES = 4 * 1024 * 1024;
/** An eval `results.json` carries a transcript per sample and can be large. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;
/** One session transcript. Past this, ask for a narrower query. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
/** Default cap on events parsed out of session logs in one call. */
const DEFAULT_MAX_EVENTS = 200_000;
/**
 * Default cap on the audit chain `AuditVerify` will walk, in bytes.
 *
 * `@crewhaus/audit-log`'s `verify` streams the chain and takes no deadline
 * and no abort signal, so once it is called it runs to completion: the only
 * honest bound this tool can put on that work is to measure it FIRST and
 * refuse up front. Raise it with `maxBytes` when a chain is genuinely large.
 */
const DEFAULT_MAX_AUDIT_BYTES = 256 * 1024 * 1024;

/** Where a harness keeps its state, by convention. */
const DEFAULT_SESSIONS_DIR = ".crewhaus/sessions";
const DEFAULT_AUDIT_DIR = ".crewhaus/audit";

// ---------------------------------------------------------------------------
// shared input plumbing
// ---------------------------------------------------------------------------

/**
 * Why a load failed, when the caller has to branch on it.
 *
 * `missing` is the only one a tool may treat as "carry on and let the report
 * say so"; every other code is a refusal the caller must return. Kept as a
 * field rather than sniffed out of the message so a reworded message can
 * never silently turn a refusal into a carry-on.
 */
type LoadFailure = "refused" | "missing" | "too-large" | "not-a-file" | "bad-input";

type Loaded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly code: LoadFailure };

const specSourceFields = {
  spec: z.string().optional().describe("the spec YAML text, inline"),
  path: z
    .string()
    .optional()
    .describe("path to a spec file instead, relative to the working directory"),
};

const specSourceSchema = z.object(specSourceFields);
type SpecSource = z.infer<typeof specSourceSchema>;

/** Read a contained file as UTF-8, refusing anything over `maxBytes`. */
function readContained(toolName: string, rel: string, maxBytes: number): Loaded<string> {
  const shown = renderPath(rel);
  let safe: SafePath;
  try {
    safe = resolveSafe(toolName, rel);
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return { ok: false, message: err.message, code: "refused" };
    }
    throw err;
  }
  let size: number;
  try {
    const stat = statSync(safe.real);
    if (!stat.isFile())
      return { ok: false, message: `"${shown}" is not a file`, code: "not-a-file" };
    size = stat.size;
  } catch {
    return { ok: false, message: `"${shown}" does not exist or is unreadable`, code: "missing" };
  }
  // The cap is applied to the SIZE ON DISK, before a byte is read, so the
  // refusal costs no memory. A cap applied after the read would not be one.
  if (size > maxBytes) {
    return {
      ok: false,
      message: `"${shown}" is ${size} bytes, over the ${maxBytes} limit for this tool`,
      code: "too-large",
    };
  }
  try {
    return { ok: true, value: readFileSync(safe.real, "utf8") };
  } catch {
    // The node error text carries the ABSOLUTE path, which is workspace
    // layout the caller did not supply and does not need.
    return { ok: false, message: `"${shown}" could not be read`, code: "missing" };
  }
}

/** Resolve a directory argument, or say why it cannot be used. */
function resolveDir(toolName: string, rel: string): Loaded<SafePath> {
  const shown = renderPath(rel);
  let safe: SafePath;
  try {
    safe = resolveSafe(toolName, rel);
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return { ok: false, message: err.message, code: "refused" };
    }
    throw err;
  }
  try {
    if (!statSync(safe.real).isDirectory()) {
      return { ok: false, message: `"${shown}" is not a directory`, code: "not-a-file" };
    }
  } catch {
    return { ok: false, message: `"${shown}" does not exist or is unreadable`, code: "missing" };
  }
  return { ok: true, value: safe };
}

/** Exactly one of `spec` / `path`, read and size-checked. */
function loadSpecText(toolName: string, source: SpecSource, label = ""): Loaded<string> {
  const which = label === "" ? "" : `${label}: `;
  if (source.spec !== undefined && source.path !== undefined) {
    return {
      ok: false,
      message: `${which}pass either "spec" or "path", not both`,
      code: "bad-input",
    };
  }
  if (source.spec !== undefined) {
    if (source.spec.length > MAX_SPEC_BYTES) {
      return {
        ok: false,
        message: `${which}spec text is over the ${MAX_SPEC_BYTES} byte limit`,
        code: "too-large",
      };
    }
    return { ok: true, value: source.spec };
  }
  if (source.path !== undefined) {
    const read = readContained(toolName, source.path, MAX_SPEC_BYTES);
    return read.ok ? read : { ok: false, message: `${which}${read.message}`, code: read.code };
  }
  return {
    ok: false,
    message: `${which}pass the spec as "spec" (YAML text) or "path" (a file)`,
    code: "bad-input",
  };
}

/** Parse, turning the thrown error into a readable refusal with the issues. */
function parseOrExplain(text: string, label = "spec"): Loaded<Spec> {
  try {
    return { ok: true, value: parseSpec(text) };
  } catch {
    const issues = parseSpecIssues(text).slice(0, 5);
    const rendered = issues
      .map((i) => `  ${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.message}`)
      .join("\n");
    return {
      ok: false,
      message: `the ${label} does not parse — run SpecValidate for the full list:\n${rendered}`,
      code: "bad-input",
    };
  }
}

function renderIssuePath(segments: ReadonlyArray<string | number>): string {
  return segments.length > 0 ? segments.join(".") : "<root>";
}

function specView(text: string, label = "spec"): Loaded<SpecView> {
  const parsed = parseOrExplain(text, label);
  if (!parsed.ok) return parsed;
  return { ok: true, value: buildSpecView(parsed.value, collectSpecModels(parsed.value)) };
}

function warningJson(warnings: ReadonlyArray<CompileWarning>): Array<Record<string, string>> {
  return [...warnings]
    .map((w) => ({ code: w.code, path: w.path, message: w.message }))
    .sort(
      (a, b) =>
        compareStrings(a.path, b.path) ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.message, b.message),
    );
}

function itemJson(item: PreflightItem): Record<string, string> {
  return {
    id: item.id,
    area: item.area,
    message: item.message,
    ...(item.remediation !== undefined ? { remediation: item.remediation } : {}),
    ...(item.envVar !== undefined ? { envVar: item.envVar } : {}),
  };
}

/** A session id is a filename component: never a path, never a traversal. */
function sessionFileName(sessionId: string): Loaded<string> {
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
    return {
      ok: false,
      message: `"${renderPath(sessionId)}" is not a session id — it looks like a path`,
      code: "refused",
    };
  }
  return { ok: true, value: sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl` };
}

type LoadedEvents = {
  readonly events: SessionEvent[];
  readonly files: string[];
  readonly malformedLines: number;
  readonly truncated: boolean;
  readonly skipped: string[];
};

/**
 * Read one session log, or every `*.jsonl` under the sessions directory, in
 * sorted filename order so the same directory always parses the same way.
 */
function loadSessionEvents(
  toolName: string,
  dirRel: string,
  sessionId: string | undefined,
  maxEvents: number,
): Loaded<LoadedEvents> {
  const dir = resolveDir(toolName, dirRel);
  if (!dir.ok) return dir;
  let names: string[];
  if (sessionId !== undefined) {
    const file = sessionFileName(sessionId);
    if (!file.ok) return file;
    names = [file.value];
  } else {
    try {
      names = readdirSync(dir.value.real)
        .filter((n) => n.endsWith(".jsonl"))
        .sort(compareStrings);
    } catch (err) {
      return { ok: false, message: `"${renderPath(dirRel)}" could not be listed`, code: "missing" };
    }
  }

  const events: SessionEvent[] = [];
  const files: string[] = [];
  const skipped: string[] = [];
  let malformedLines = 0;
  let truncated = false;
  for (const name of names) {
    if (events.length >= maxEvents) {
      truncated = true;
      break;
    }
    const rel = toPosix(path.join(dirRel, name));
    const read = readContained(toolName, rel, MAX_LOG_BYTES);
    if (!read.ok) {
      if (sessionId !== undefined) return read;
      skipped.push(`${name}: ${read.message}`);
      continue;
    }
    const parsed = parseSessionLog(
      name.replace(/\.jsonl$/, ""),
      read.value,
      maxEvents - events.length,
    );
    events.push(...parsed.events);
    malformedLines += parsed.malformedLines;
    if (parsed.truncated) truncated = true;
    files.push(name);
  }
  return {
    ok: true,
    value: { events, files, malformedLines, truncated, skipped: skipped.sort(compareStrings) },
  };
}

// ---------------------------------------------------------------------------
// spec tools
// ---------------------------------------------------------------------------

export const specValidate: RegisteredTool = buildTool({
  name: "SpecValidate",
  description:
    "Validate a CrewHaus spec and return EVERY YAML, schema and cross-field issue with the path that owns it. Use to check a spec a human or a model just edited before anything tries to compile or spawn it — unlike `crewhaus compile`, which stops at the first problem, this reports them all at once. It says nothing about whether the harness will run: credentials, ports and model availability are live facts, not spec facts.",
  inputSchema: specSourceSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const text = loadSpecText("SpecValidate", input);
    if (!text.ok) return text.message;
    const issues = parseSpecIssues(text.value);
    return json({
      valid: issues.length === 0,
      issueCount: issues.length,
      // Issue ORDER is meaningful and preserved: the spec package checks YAML
      // syntax, then schema, then cross-field invariants, and the first issue
      // is the one `parseSpec` would have thrown.
      issues: issues.map((issue) => ({
        path: renderIssuePath(issue.path),
        code: issue.code,
        message: issue.message,
      })),
    });
  },
});

export const specCompileCheck: RegisteredTool = buildTool({
  name: "SpecCompileCheck",
  description:
    'Run the real compiler over a spec in memory and report the warnings and any error, writing no bundle anywhere. Use as the offline "will this build" gate in a deploy pipeline: it lowers and emits exactly as `crewhaus compile` does, so a spec that passes here produces a bundle. It does not write, run or install that bundle, and it cannot tell you the harness will work — only that it compiles.',
  inputSchema: z.object({
    ...specSourceFields,
    strict: z
      .boolean()
      .optional()
      .describe("fail on an outward-reaching tool the compiler cannot verify offline"),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "the date the model-sunset check compares against; omitted, the compiler uses the host's current date, which is the one place a clock enters the result",
      ),
    includeFiles: z.boolean().optional().describe("list the emitted file paths as well"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const text = loadSpecText("SpecCompileCheck", input);
    if (!text.ok) return text.message;
    try {
      const result = compile(text.value, {
        ...(input.strict === true ? { strict: true } : {}),
        ...(input.today !== undefined ? { today: input.today } : {}),
      });
      const files = [...result.files].sort((a, b) => compareStrings(a.path, b.path));
      return json({
        ok: true,
        fileCount: files.length,
        // Real UTF-8 bytes, not `content.length` (UTF-16 code units), so a
        // bundle with non-ASCII content is not under-reported.
        totalBytes: files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0),
        warningCount: result.warnings.length,
        warnings: warningJson(result.warnings),
        ...(input.includeFiles === true ? { files: files.map((f) => f.path) } : {}),
      });
    } catch (err) {
      const error = err as Error;
      return json({
        ok: false,
        error: { name: error.name, message: error.message },
        warningCount: 0,
        warnings: [],
      });
    }
  },
});

export const specSummarize: RegisteredTool = buildTool({
  name: "SpecSummarize",
  description:
    "Summarize a spec as structured JSON: shape, models, the tools granted at each site, MCP servers, permission rules and which optional blocks are declared. Use to see what a harness IS without reading its YAML — the projection is shape-agnostic, so a workflow, a crew and a channel all come back in the same form. MCP `env` and `headers` are reported by key only, an `sse` URL is reduced to origin and path, and a stdio server's argv has its credential-shaped entries redacted, so a credential pasted into a spec is not echoed into the report.",
  inputSchema: specSourceSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const text = loadSpecText("SpecSummarize", input);
    if (!text.ok) return text.message;
    const view = specView(text.value);
    if (!view.ok) return view.message;
    return json(view.value);
  },
});

export const specDiff: RegisteredTool = buildTool({
  name: "SpecDiff",
  description:
    "Compare two specs semantically — a tool granted, a server added, a permission rule dropped, a model swapped — and flag which changes WIDEN what the harness can do. Use to review a spec edit before it ships: reordered keys, comments and reformatting are invisible here because both sides are parsed first. It compares structure only, so it cannot tell you that a rewritten instruction changed the agent's behaviour.",
  inputSchema: z.object({
    before: specSourceSchema.describe("the spec as it was"),
    after: specSourceSchema.describe("the spec as it is now"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const beforeText = loadSpecText("SpecDiff", input.before, "before");
    if (!beforeText.ok) return beforeText.message;
    const afterText = loadSpecText("SpecDiff", input.after, "after");
    if (!afterText.ok) return afterText.message;
    const before = specView(beforeText.value, "before spec");
    if (!before.ok) return before.message;
    const after = specView(afterText.value, "after spec");
    if (!after.ok) return after.message;
    const changes = diffSpecViews(before.value, after.value);
    const widening = changes.filter((c) => c.widens);
    return json({
      changed: changes.length > 0,
      widens: widening.length > 0,
      counts: { changes: changes.length, widening: widening.length },
      changes,
    });
  },
});

export const toolInventory: RegisteredTool = buildTool({
  name: "ToolInventory",
  description:
    "List the tools a spec grants, split into builtins and MCP tools, with `all-<category>` selectors expanded the way the compiler expands them. Use to answer what a harness can reach before granting it more. An MCP tool naming a server the spec does not declare is flagged as dangling, and a builtin key that is not a real tool is reported as unknown — checked against this release's builtin manifest unless you pass `knownTools` for a different runtime.",
  inputSchema: z.object({
    ...specSourceFields,
    knownTools: z
      .array(z.string())
      .optional()
      .describe(
        "the tool names that exist in a DIFFERENT target runtime (e.g. a bundle compiled from another release); omit to check against this release's builtins",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const text = loadSpecText("ToolInventory", input);
    if (!text.ok) return text.message;
    const parsed = parseOrExplain(text.value);
    if (!parsed.ok) return parsed.message;

    let expanded: Spec = parsed.value;
    let categoryError: string | undefined;
    try {
      expanded = expandSpecToolCategories(parsed.value);
    } catch (err) {
      categoryError = (err as Error).message;
    }
    const declared = buildSpecView(parsed.value, []);
    const resolved = buildSpecView(expanded, []);
    const servers = new Set(Object.keys(asRecord(asRecord(parsed.value)?.["mcp_servers"]) ?? {}));
    // The builtin set used to be uncheckable from here: the registry lived in
    // the compiled bundle, so this tool could only compare against a list the
    // caller happened to pass, and said so in a note. The set is in the tree
    // now, so the default is the real one and every answer carries `unknown`.
    // An explicit `knownTools` still wins, because a spec can legitimately be
    // checked against a runtime that is not this one — a bundle compiled from
    // another release has a different builtin set.
    //
    // The set comes from `BUILTIN_TOOL_MAP` and NOT from
    // `@crewhaus/tool-registry-manifest`, although the manifest has the same
    // keys. This tool needs the key SET; the manifest is 455 KB of key set
    // plus description prose, and `collectCrewhausDeps` pins whole packages,
    // so importing it here would put that prose into every bundle granting
    // any tool-crewhaus tool — and `crewhaus` sits inside the `all-operations`
    // roll-up, so a plain `all-operations` grant would pay it too. `target-cli`
    // is already in this package's dependency closure via `@crewhaus/compiler`,
    // so this costs nothing. That the two key sets are identical is not an
    // assumption: `apps/cli/src/tool-registry.test.ts` asserts it in both
    // directions on every run.
    const usedCallerList = input.knownTools !== undefined;
    const known = usedCallerList
      ? new Set(input.knownTools)
      : new Set(Object.keys(BUILTIN_TOOL_MAP));

    const builtin: string[] = [];
    const mcp: Array<{ tool: string; server: string; declared: boolean }> = [];
    const unknown: string[] = [];
    for (const tool of resolved.tools) {
      if (tool.startsWith("mcp__")) {
        const server = tool.slice("mcp__".length).split("__")[0] ?? "";
        mcp.push({ tool, server, declared: servers.has(server) });
        continue;
      }
      builtin.push(tool);
      if (!known.has(tool) && !known.has(toRegisteredName(tool))) {
        unknown.push(tool);
      }
    }

    return json({
      ...(categoryError !== undefined ? { categoryError } : {}),
      categoriesExpanded: declared.tools.length !== resolved.tools.length,
      counts: { total: resolved.tools.length, builtin: builtin.length, mcp: mcp.length },
      builtin,
      mcp,
      dangling: mcp.filter((m) => !m.declared).map((m) => m.tool),
      unknown,
      checkedAgainst: usedCallerList ? "the knownTools you passed" : "this release's builtins",
      sites: resolved.toolSites,
      declaredSelectors: declared.toolSites,
    });
  },
});

export const permissionAudit: RegisteredTool = buildTool({
  name: "PermissionAudit",
  description:
    "Report what a spec's permission rules actually cover: the effective mode, the rule that speaks to each granted tool, the rules that match nothing, and the tools that reach outside the process with no rule naming them. Use as the \"what can this harness really do\" review before deploying it. It sees the spec's own rules only — CLI flags, `.crewhaus/settings.json` rules and the builtin floor also apply at run time — and it matches the tool-name half of a pattern, reporting an argument-scoped rule like `Bash(git *)` as conditional cover rather than pretending to evaluate future arguments. A rule the matcher cannot compile is listed under `malformedRules` and treated the way the engine treats it (a broken deny or ask gates everything; a broken allow is dropped), and under `mode: plan` it says so, because there the engine decides on the tool's readOnly flag and reads no rule at all.",
  inputSchema: z.object({
    ...specSourceFields,
    destructiveTools: z
      .array(z.string())
      .optional()
      .describe(
        "tools the target runtime marks destructive; the spec cannot know this for builtins, so pass it to get them flagged",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const text = loadSpecText("PermissionAudit", input);
    if (!text.ok) return text.message;
    const view = specView(text.value);
    if (!view.ok) return view.message;

    // The one destructive signal a spec carries on its own: an MCP server's
    // narrowing `tool_flags`.
    const destructive = new Set(input.destructiveTools ?? []);
    const flaggedDefaults: string[] = [];
    const parsed = parseOrExplain(text.value);
    if (parsed.ok) {
      const servers = asRecord(asRecord(parsed.value)?.["mcp_servers"]) ?? {};
      for (const [server, raw] of Object.entries(servers)) {
        const flags = asRecord(asRecord(raw)?.["tool_flags"]);
        if (flags === undefined) continue;
        if (asRecord(flags["defaults"])?.["destructive"] === true) flaggedDefaults.push(server);
        for (const [tool, entry] of Object.entries(asRecord(flags["per_tool"]) ?? {})) {
          if (asRecord(entry)?.["destructive"] === true) destructive.add(`mcp__${server}__${tool}`);
        }
      }
    }

    const result = auditPermissions({
      tools: view.value.tools,
      mode: view.value.permissions.mode,
      askMode: view.value.permissions.askMode,
      rules: view.value.permissions.rules,
      destructiveTools: destructive,
    });
    return json({
      ...result,
      ...(flaggedDefaults.length > 0
        ? {
            destructiveServerDefaults: flaggedDefaults.sort(compareStrings),
            note: "these servers declare tool_flags.defaults.destructive — every tool they expose is destructive, including ones this spec does not name",
          }
        : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// harness-state tools
// ---------------------------------------------------------------------------

export const preflightRun: RegisteredTool = buildTool({
  name: "PreflightRun",
  description:
    "Run the full preflight over a harness directory against an EXPLICITLY supplied environment, returning the blocking items, the warnings and the remediation for each. Use before spawning a harness, to turn the stack trace the spawn would die with into a list of things to fix. The environment is an input and is never read from this process, so pass the merged env the spawn would actually receive. It binds each declared port briefly to see whether it is free, and it reaches no network beyond that.",
  inputSchema: z.object({
    harnessDir: z
      .string()
      .optional()
      .describe("the harness root holding crewhaus.yaml; defaults to the working directory"),
    env: z
      .record(z.string())
      .describe(
        "the environment the spawn would receive — required, never taken from this process",
      ),
    includeInfo: z.boolean().optional().describe("return the info items too, not just their count"),
    compileWarnings: z
      .boolean()
      .optional()
      .describe("also compile the spec in memory and fold its warnings in (default true)"),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("pinned date for the compiler's model-sunset check"),
  }),
  readOnly: true,
  // NOT concurrency-safe, alone in this package. The runtime runs siblings in
  // parallel when `concurrencySafe && readOnly && !destructive` holds, and the
  // port probe here is a real exclusive bind: two of these in flight over the
  // same spec race, one wins the socket, and the loser reports the harness's
  // own port as taken. A free port reported as taken is a blocking item that
  // is simply false, so this tool takes its turn.
  concurrencySafe: false,
  // Binding a port to test it is real socket I/O, so this tool is declared
  // external by capability rather than left at the internal default.
  scope: "external",
  ioCapability: "network",
  execute: async (input) => {
    const dirRel = input.harnessDir ?? ".";
    const dir = resolveDir("PreflightRun", dirRel);
    if (!dir.ok) return dir.message;

    // CONTAINMENT. `runPreflight` will happily `readFileSync` its own
    // `<harnessDir>/crewhaus.yaml`, which is a read this package's boundary
    // never saw: a `crewhaus.yaml` that is a SYMLINK out of the workspace
    // would be read, parsed, and its contents reflected back through the
    // report's messages — the exact escape `resolveSafe` exists to stop, and
    // one every other tool here refuses. So the spec is read HERE, through
    // the gate and under the size cap, and handed over as `specYaml`; with
    // that supplied, preflight never touches the file.
    const specText = readContained(
      "PreflightRun",
      toPosix(path.join(dirRel, HARNESS_SPEC_FILENAME)),
      MAX_SPEC_BYTES,
    );
    // `missing` is the one failure the report should describe rather than
    // refuse: preflight's own "crewhaus.yaml not found" blocking item is the
    // useful answer, and there is nothing to read, so nothing can escape.
    if (!specText.ok && specText.code !== "missing") return specText.message;

    let compileWarnings: string[] = [];
    if (input.compileWarnings !== false && specText.ok) {
      try {
        const result = compile(specText.value, {
          ...(input.today !== undefined ? { today: input.today } : {}),
        });
        compileWarnings = warningJson(result.warnings).map(
          (w) => `${w["code"]} at ${w["path"]}: ${w["message"]}`,
        );
      } catch {
        // A spec that will not compile is already reported as blocking by
        // the spec area; no warning to add.
      }
    }

    const report = await runPreflight({
      harnessDir: dir.value.real,
      ...(specText.ok ? { specYaml: specText.value } : {}),
      env: input.env,
      compileWarnings,
    });
    const warnings = report.items.filter((i) => i.level === "warn");
    const info = report.items.filter((i) => i.level === "info");
    return json({
      ok: report.ok,
      harnessDir: dir.value.rel === "" ? "." : dir.value.rel,
      counts: { blocking: report.blocking.length, warn: warnings.length, info: info.length },
      blocking: report.blocking.map(itemJson),
      warnings: warnings.map(itemJson),
      ...(input.includeInfo === true ? { info: info.map(itemJson) } : {}),
    });
  },
});

export const harnessInventory: RegisteredTool = buildTool({
  name: "HarnessInventory",
  description:
    "Enumerate the harnesses under a directory — name, shape, model, spec path, whether a bundle exists and whether it is older than the spec. Use to get the fleet table a supervisor starts from. A harness is any directory carrying a crewhaus.yaml, matching what `crewhaus fleet` discovers; the walk is depth-bounded, skips state and vendor directories, and never follows a directory symlink. A spec that does not parse is still listed, marked invalid, with its first issue.",
  inputSchema: z.object({
    root: z.string().optional().describe("where to look; defaults to the working directory"),
    maxDepth: z.number().int().min(0).max(12).optional().describe("walk depth cap (default 6)"),
    limit: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe("stop after this many (default 500)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const rootRel = input.root ?? ".";
    const root = resolveDir("HarnessInventory", rootRel);
    if (!root.ok) return root.message;
    const found = discoverHarnesses(root.value.real, input.maxDepth ?? 6, input.limit ?? 500);

    const harnesses = found.harnesses.map((harness) => {
      // Paths are reported relative to the WORKSPACE, not to `root`, so a
      // caller can feed them straight back into BundleFreshness or PreflightRun.
      const dirRel = toPosix(path.join(rootRel, harness.rel));
      const specRel = toPosix(path.join(dirRel, HARNESS_SPEC_FILENAME));
      const read = readContained("HarnessInventory", specRel, MAX_SPEC_BYTES);
      const identity = read.ok
        ? readSpecIdentity(read.value)
        : { valid: false, lenient: true, firstIssue: read.message };
      const freshness = compareBundleFreshnessByMtime(harness.dir);
      return {
        dir: dirRel,
        specPath: specRel,
        ...(identity.name !== undefined ? { name: identity.name } : {}),
        ...(identity.target !== undefined ? { shape: identity.target } : {}),
        ...(identity.model !== undefined ? { model: identity.model } : {}),
        specValid: identity.valid,
        ...(identity.firstIssue !== undefined ? { firstIssue: identity.firstIssue } : {}),
        bundle: freshness.state,
      };
    });

    return json({
      root: root.value.rel === "" ? "." : root.value.rel,
      count: harnesses.length,
      truncated: found.truncated,
      counts: {
        invalidSpecs: harnesses.filter((h) => !h.specValid).length,
        staleBundles: harnesses.filter((h) => h.bundle === "stale").length,
        missingBundles: harnesses.filter((h) => h.bundle === "missing-bundle").length,
      },
      harnesses,
      ...(found.unreadable.length > 0 ? { unreadable: found.unreadable } : {}),
    });
  },
});

export const bundleFreshness: RegisteredTool = buildTool({
  name: "BundleFreshness",
  description:
    'Compare each harness\'s compiled bundle against its spec and report which bundles are stale or missing, with the command that fixes them. Use to find the harnesses running yesterday\'s spec before you trust what they do. The comparison is the mtime heuristic preflight uses — mtimes lie across git checkouts, file copies and clock skew, so a `stale` verdict means "recompile to be sure", not "proven different".',
  inputSchema: z.object({
    dirs: z
      .array(z.string())
      .optional()
      .describe("harness directories to check; omitted, they are discovered under `root`"),
    root: z
      .string()
      .optional()
      .describe("where to discover harnesses (default: working directory)"),
    staleOnly: z.boolean().optional().describe("return only the bundles that need a recompile"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    let dirs: string[];
    if (input.dirs !== undefined) {
      dirs = [...input.dirs].sort(compareStrings);
    } else {
      const rootRel = input.root ?? ".";
      const root = resolveDir("BundleFreshness", rootRel);
      if (!root.ok) return root.message;
      dirs = discoverHarnesses(root.value.real).harnesses.map((h) =>
        toPosix(path.join(rootRel, h.rel)),
      );
    }

    const rows: Array<Record<string, string>> = [];
    for (const rel of dirs) {
      const dir = resolveDir("BundleFreshness", rel);
      if (!dir.ok) {
        rows.push({ dir: rel, state: "unreadable", detail: dir.message });
        continue;
      }
      const freshness = compareBundleFreshnessByMtime(dir.value.real);
      rows.push({
        dir: dir.value.rel === "" ? "." : dir.value.rel,
        state: freshness.state,
        ...(freshness.state === "stale" || freshness.state === "missing-bundle"
          ? { remediation: "crewhaus compile crewhaus.yaml" }
          : {}),
      });
    }
    const needsWork = rows.filter((r) => r["state"] === "stale" || r["state"] === "missing-bundle");
    return json({
      checked: rows.length,
      counts: {
        fresh: rows.filter((r) => r["state"] === "fresh").length,
        stale: rows.filter((r) => r["state"] === "stale").length,
        missingBundle: rows.filter((r) => r["state"] === "missing-bundle").length,
        missingSpec: rows.filter((r) => r["state"] === "missing-spec").length,
      },
      method: "mtime heuristic (approximate — mtimes lie across checkouts and copies)",
      bundles: input.staleOnly === true ? needsWork : rows,
    });
  },
});

/**
 * Total bytes of the `*.jsonl` files directly under an audit directory, or
 * `undefined` when the directory cannot be listed. Not recursive, because
 * `verify` is not: it reads exactly this set.
 */
function chainBytes(dirReal: string): number | undefined {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dirReal);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      total += statSync(path.join(dirReal, name)).size;
    } catch {
      // Raced deletion — `verify` will skip it too.
    }
  }
  return total;
}

export const auditVerify: RegisteredTool = buildTool({
  name: "AuditVerify",
  description:
    "Re-walk a harness's audit log hash chain and report whether it is intact, plus the file and line of the first break. Use to check that the tamper-evident record has not been edited or truncated. Read the two caveats it returns: `anchorChecked: false` means tail truncation could not be ruled out, and even a matching on-host anchor is rewritable by anything running as the same user — only an off-host anchor store settles that, and this tool does not have one. The walk cannot be interrupted once it starts, so a chain larger than `maxBytes` is refused before it begins rather than run without a deadline.",
  inputSchema: z.object({
    dir: z
      .string()
      .optional()
      .describe("the audit log directory; defaults to .crewhaus/audit under the working directory"),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `refuse rather than walk a chain larger than this (default ${DEFAULT_MAX_AUDIT_BYTES}); the walk itself cannot be interrupted once it starts, so the bound is applied before it`,
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const rel = input.dir ?? DEFAULT_AUDIT_DIR;
    const dir = resolveDir("AuditVerify", rel);
    if (!dir.ok) return dir.message;
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_AUDIT_BYTES;
    const size = chainBytes(dir.value.real);
    if (size === undefined) {
      return `audit log at "${renderPath(rel)}" could not be listed`;
    }
    if (size > maxBytes) {
      return `audit log at "${renderPath(rel)}" is ${size} bytes across its *.jsonl files, over the ${maxBytes} limit — raise maxBytes to walk it anyway`;
    }
    let result: VerifyResult;
    try {
      result = await verifyAuditChain(dir.value.real);
    } catch (err) {
      return `audit log at "${renderPath(rel)}" could not be verified: ${(err as Error).message}`;
    }
    if (result.ok) {
      return json({
        ok: true,
        dir: dir.value.rel === "" ? "." : dir.value.rel,
        recordsChecked: result.recordsChecked,
        anchorChecked: result.anchorChecked,
        externalAnchorChecked: result.externalAnchorChecked,
        ...(result.anchorChecked
          ? {}
          : {
              caveat:
                "no on-host tail anchor was present, so records dropped from the END of the chain cannot be ruled out",
            }),
      });
    }
    // Report the break inside the audit directory the caller named, never a
    // `../..` walk back out of the workspace.
    const broken = path.isAbsolute(result.file)
      ? toPosix(path.relative(dir.value.real, result.file))
      : result.file;
    return json({
      ok: false,
      dir: dir.value.rel === "" ? "." : dir.value.rel,
      recordsChecked: result.recordsChecked,
      break: { file: broken, line: result.line, reason: result.reason },
    });
  },
});

// ---------------------------------------------------------------------------
// evidence tools
// ---------------------------------------------------------------------------

const evalDocSchema = z.union([
  z.string().describe("the document as JSON text"),
  z.record(z.unknown()).describe("the document as an object"),
]);

function loadEvalDoc(
  toolName: string,
  label: string,
  doc: string | Record<string, unknown> | undefined,
  filePath: string | undefined,
): Loaded<EvalRunView> {
  if (doc !== undefined && filePath !== undefined) {
    return {
      ok: false,
      message: `${label}: pass either the document or its path, not both`,
      code: "bad-input",
    };
  }
  let raw: unknown;
  if (typeof doc === "string" || filePath !== undefined) {
    const text =
      typeof doc === "string"
        ? ({ ok: true, value: doc } as const)
        : readContained(toolName, filePath as string, MAX_JSON_BYTES);
    if (!text.ok) return { ok: false, message: `${label}: ${text.message}`, code: text.code };
    try {
      raw = JSON.parse(text.value);
    } catch (err) {
      return {
        ok: false,
        message: `${label}: not valid JSON — ${(err as Error).message}`,
        code: "bad-input",
      };
    }
  } else if (doc !== undefined) {
    raw = doc;
  } else {
    return {
      ok: false,
      message: `${label}: pass the eval document, or a path to it`,
      code: "bad-input",
    };
  }
  const read = readEvalRun(raw, label);
  return read.ok
    ? { ok: true, value: read.run }
    : { ok: false, message: read.error, code: "bad-input" };
}

export const evalBaselineCompare: RegisteredTool = buildTool({
  name: "EvalBaselineCompare",
  description:
    "Gate a candidate eval run against its baseline: pass-rate delta, the samples that went pass to fail, the ones that recovered, and whether the declared thresholds hold. Use as the release gate after an eval — the verdict is a pure function of the two result documents, so it needs no eval runner and no model. Samples are matched by id; one present on only one side is reported but never counted as a regression, and a candidate sample whose judge abstained or whose invoker errored is listed as inconclusive so judge noise is not mistaken for a real fall. A repeated sample id, and a declared pass rate its own samples do not support, are both reported as notes; a declared rate outside 0..1 is refused outright and recomputed.",
  inputSchema: z.object({
    baseline: evalDocSchema.optional().describe("the baseline run's results document"),
    baselinePath: z.string().optional().describe("path to the baseline results.json instead"),
    candidate: evalDocSchema.optional().describe("the candidate run's results document"),
    candidatePath: z.string().optional().describe("path to the candidate results.json instead"),
    minPassRate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("absolute floor the candidate must clear"),
    maxPassRateDrop: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("how far the pass rate may fall below the baseline (default 0)"),
    maxRegressions: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("how many shared samples may go pass to fail (default 0)"),
    scoreEpsilon: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("verdict-preserving score moves smaller than this are not reported (default 0.1)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const baseline = loadEvalDoc(
      "EvalBaselineCompare",
      "baseline",
      input.baseline,
      input.baselinePath,
    );
    if (!baseline.ok) return baseline.message;
    const candidate = loadEvalDoc(
      "EvalBaselineCompare",
      "candidate",
      input.candidate,
      input.candidatePath,
    );
    if (!candidate.ok) return candidate.message;
    const thresholds: EvalGateThresholds = {
      ...(input.minPassRate !== undefined ? { minPassRate: input.minPassRate } : {}),
      ...(input.maxPassRateDrop !== undefined ? { maxPassRateDrop: input.maxPassRateDrop } : {}),
      ...(input.maxRegressions !== undefined ? { maxRegressions: input.maxRegressions } : {}),
      ...(input.scoreEpsilon !== undefined ? { scoreEpsilon: input.scoreEpsilon } : {}),
    };
    return json({
      ...compareEvalRuns(baseline.value, candidate.value, thresholds),
      runs: {
        baseline: { runId: baseline.value.runId, samples: baseline.value.sampleCount },
        candidate: { runId: candidate.value.runId, samples: candidate.value.sampleCount },
      },
    });
  },
});

const sessionSourceFields = {
  dir: z.string().optional().describe("the session log directory; defaults to .crewhaus/sessions"),
  sessionId: z
    .string()
    .optional()
    .describe("one session id; omitted, every *.jsonl in the directory is read"),
  maxEvents: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .optional()
    .describe("cap on events parsed (default 200000)"),
};

export const sessionSummarize: RegisteredTool = buildTool({
  name: "SessionSummarize",
  description:
    "Summarize a harness's session transcripts: event counts by kind, a per-tool call and error tally, MCP call health and the errors that were recorded. Use to see what a harness has actually been doing without reading a JSONL file into context. Malformed lines are counted rather than thrown on, because a transcript truncated by a killed process is the normal case; a tool call is counted from its `tool_use` record, with the `tool_stats` mirror supplying durations and errors so nothing is counted twice.",
  inputSchema: z.object(sessionSourceFields),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadSessionEvents(
      "SessionSummarize",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    return json({
      files: loaded.value.files.length,
      malformedLines: loaded.value.malformedLines,
      truncated: loaded.value.truncated,
      ...(loaded.value.skipped.length > 0 ? { skipped: loaded.value.skipped } : {}),
      ...summarizeEvents(loaded.value.events),
    });
  },
});

export const traceQuery: RegisteredTool = buildTool({
  name: "TraceQuery",
  description:
    "Return a filtered slice of a harness's session events — by kind, by timestamp range, by a substring of the payload — in log order. Use to pull the few events that matter out of a long transcript: the permission decisions, the model failovers, the calls to one tool. Payloads are truncated to keep a result readable, so treat this as a window onto the log rather than a copy of it.",
  inputSchema: z.object({
    ...sessionSourceFields,
    kinds: z
      .array(z.string())
      .optional()
      .describe('event kinds to keep, e.g. ["tool_use","error"]'),
    sinceTs: z.number().int().optional().describe("epoch ms, inclusive lower bound"),
    untilTs: z.number().int().optional().describe("epoch ms, inclusive upper bound"),
    contains: z.string().optional().describe("case-sensitive substring of the serialized payload"),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("events to return (default 50)"),
    offset: z.number().int().min(0).optional().describe("how many matches to skip (default 0)"),
    order: z
      .enum(["oldest", "newest"])
      .optional()
      .describe(
        "which end of the log order to take from — log order is filename then line, not a timestamp sort (default oldest)",
      ),
    maxPayloadChars: z
      .number()
      .int()
      .positive()
      .max(20_000)
      .optional()
      .describe("per-event payload budget (default 500)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadSessionEvents(
      "TraceQuery",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    const matched = filterEvents(loaded.value.events, {
      ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
      ...(input.sinceTs !== undefined ? { sinceTs: input.sinceTs } : {}),
      ...(input.untilTs !== undefined ? { untilTs: input.untilTs } : {}),
      ...(input.contains !== undefined ? { contains: input.contains } : {}),
    });
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const budget = input.maxPayloadChars ?? 500;
    const ordered = input.order === "newest" ? [...matched].reverse() : matched;
    const slice = ordered.slice(offset, offset + limit);
    return json({
      matched: matched.length,
      returned: slice.length,
      offset,
      truncated: loaded.value.truncated,
      events: slice.map((event) => {
        const payload = json(event.payload ?? null);
        return {
          session: event.session,
          line: event.line,
          ...(event.ts !== undefined ? { ts: event.ts } : {}),
          kind: event.kind,
          payload: payload.length > budget ? `${payload.slice(0, budget)}…` : payload,
          ...(payload.length > budget ? { payloadTruncated: true } : {}),
        };
      }),
    });
  },
});

export const costSummarize: RegisteredTool = buildTool({
  name: "CostSummarize",
  description:
    "Total the cost and token accruals in a harness's session logs, broken down by model, by provider and by UTC day. Use to see where a fleet's spend went without a billing API. Figures come from the `cost_accrual` records the runtime writes when cost tracking is on, so a harness that ran without it reports zero accruals rather than an estimate; costs stay in integer USD micros, the unit the records carry, and an accrual for a model with no pricing row is counted under `unpriced` with its real token counts and no cost.",
  inputSchema: z.object(sessionSourceFields),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadSessionEvents(
      "CostSummarize",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    return json({
      files: loaded.value.files.length,
      truncated: loaded.value.truncated,
      ...(loaded.value.skipped.length > 0 ? { skipped: loaded.value.skipped } : {}),
      ...summarizeCost(loaded.value.events),
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const CREWHAUS_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  auditVerify,
  bundleFreshness,
  costSummarize,
  evalBaselineCompare,
  harnessInventory,
  permissionAudit,
  preflightRun,
  sessionSummarize,
  specCompileCheck,
  specDiff,
  specSummarize,
  specValidate,
  toolInventory,
  traceQuery,
]);
