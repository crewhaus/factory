import { applySpecPatch } from "@crewhaus/spec-patch";

/**
 * Item 40 — `crewhaus doctor --fix`. The MUTATING half of the "doctor that
 * detects and fixes" pair. Every doctor check today prints a remediation
 * string and exits; `--fix` attaches a mechanical fixer to the checks where a
 * SAFE deterministic fix exists, and leaves the rest advisory.
 *
 * Dry-run is the DEFAULT: without `--fix`, doctor plans the fixes and prints a
 * diff of what it WOULD do; `--fix` opts into applying them. This module is
 * side-effect-free — it computes {@link FixAction}s over injected fs seams and
 * a per-fixer planner; the CLI wrapper in `index.ts` executes the plan (or
 * just prints it) and owns all real I/O. That keeps every fix path
 * unit-testable from fixtures, mirroring `scope-audit.ts` / `doctor-checks.ts`.
 */

/** One planned change. `apply()` performs the real mutation; the CLI calls it
 *  only when `--fix` is passed. `diff` is the human-readable preview printed in
 *  both dry-run and applied modes. */
export type FixAction = {
  /** Stable id of the check this remediates (for grouping/output). */
  readonly check: string;
  /** One-line summary of the change. */
  readonly summary: string;
  /** Multi-line diff preview (created/edited content). */
  readonly diff: string;
  /** Perform the mutation. Throws on failure; the CLI reports it. */
  apply(): void;
};

/** Injected filesystem seam — every fixer reads/writes through this so the
 *  planner is pure and testable. Mirrors the node:fs subset the fixers need. */
export type FixFs = {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, content: string): void;
  mkdirp(path: string): void;
};

/** Render an "added file" diff block (all `+` lines). */
function addedDiff(path: string, content: string): string {
  const body = content
    .split("\n")
    .map((l) => `+ ${l}`)
    .join("\n");
  return `--- /dev/null\n+++ ${path}\n${body}`;
}

/**
 * Fixer 1 — scaffold a missing `crewhaus.yaml`. The check "crewhaus.yaml in
 * cwd" is advisory today (`run \`crewhaus init\``); `--fix` writes the SAME
 * minimal cli spec `runInit` scaffolds, so a fresh directory becomes runnable
 * in one command. `specName` is the cwd basename (matching `init`'s default).
 * Returns undefined when the spec already exists (nothing to fix).
 */
export function planScaffoldSpec(opts: {
  readonly fs: FixFs;
  readonly specPath: string;
  readonly specName: string;
}): FixAction | undefined {
  if (opts.fs.exists(opts.specPath)) return undefined;
  const content = `name: ${opts.specName}
target: cli
agent:
  model: claude-opus-4-7
  instructions: |
    You are a helpful assistant. Replace these instructions with your
    agent's actual behavior, persona, and constraints.
`;
  return {
    check: "crewhaus.yaml in cwd",
    summary: `create ${opts.specPath} (minimal cli spec)`,
    diff: addedDiff(opts.specPath, content),
    apply: () => opts.fs.write(opts.specPath, content),
  };
}

/**
 * Fixer 2 — create missing `.crewhaus` state dirs. The runtime resolves the
 * session store and audit/eval/spec sub-stores under `.crewhaus/`; a missing
 * root is harmless (the runtime mkdirs on demand) but pre-creating it is a
 * safe, idempotent convenience the operator can preview. Returns undefined
 * when the dir already exists.
 */
export function planCrewhausDirs(opts: {
  readonly fs: FixFs;
  readonly crewhausDir: string;
}): FixAction | undefined {
  if (opts.fs.exists(opts.crewhausDir)) return undefined;
  return {
    check: ".crewhaus state dir",
    summary: `create ${opts.crewhausDir}/`,
    diff: `--- /dev/null\n+++ ${opts.crewhausDir}/  (directory)`,
    apply: () => opts.fs.mkdirp(opts.crewhausDir),
  };
}

/**
 * Fixer 3 — mark an outward-reaching tool `scope: external` via a mechanical
 * CST spec-patch. `auditToolScopes` (surfaced through `doctor
 * --philosophy-alignment` / `compile --strict`) flags outward sinks left at a
 * non-external scope; the safe mechanical fix is to set their scope, which
 * `applySpecPatch` writes back preserving comments + key order.
 *
 * NOTE: the built-in `tools:` list is an array of NAME strings — there is no
 * per-tool `scope` field to patch there (scope is a property of the registered
 * tool, not the spec reference). This fixer therefore targets a `tool_config`
 * entry: it sets `tool_config.<name>.scope: "external"`, the documented place a
 * spec asserts an operator-vetted scope. The patch is validated by
 * `applySpecPatch` (re-parses through `parseSpec`), so an unpatchable finding
 * surfaces as a thrown error the CLI reports rather than a silent no-op.
 *
 * Returns undefined for findings whose tool name is not a plain identifier
 * (e.g. an `mcp__*` dynamic sink) — those need human vetting, not a mechanical
 * scope stamp, so they stay advisory.
 */
const PLAIN_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function planScopeFix(opts: {
  readonly fs: FixFs;
  readonly specPath: string;
  readonly specTarget: string;
  readonly toolName: string;
}): FixAction | undefined {
  // `mcp__server__tool` dynamic sinks match the identifier charset but are
  // definitionally external and must be vetted by a human, not stamped
  // mechanically — leave them advisory.
  if (opts.toolName.startsWith("mcp__")) return undefined;
  if (!PLAIN_TOOL_NAME_RE.test(opts.toolName)) return undefined;
  const path = ["tool_config", opts.toolName, "scope"];
  const summary = `set tool_config.${opts.toolName}.scope: "external" in ${opts.specPath}`;
  return {
    check: "tool scope audit",
    summary,
    diff: `~ ${opts.specPath}: + tool_config.${opts.toolName}.scope: "external"`,
    apply: () => {
      const yamlText = opts.fs.read(opts.specPath);
      const result = applySpecPatchAddOrReplace(yamlText, {
        target: opts.specTarget as Parameters<typeof applySpecPatch>[1]["target"],
        path,
        value: "external",
        rationale: "doctor --fix: mark outward tool external (scope audit)",
      });
      opts.fs.write(opts.specPath, result);
    },
  };
}

/** Apply a spec patch as "add", retrying as "replace" when the path exists.
 *  Both go through `applySpecPatch`, so the result is always re-validated. */
function applySpecPatchAddOrReplace(
  yamlText: string,
  patch: {
    target: Parameters<typeof applySpecPatch>[1]["target"];
    path: readonly string[];
    value: unknown;
    rationale: string;
  },
): string {
  try {
    return applySpecPatch(yamlText, { ...patch, op: "add" }).yaml;
  } catch {
    return applySpecPatch(yamlText, { ...patch, op: "replace" }).yaml;
  }
}

/**
 * Fixer 4 — append commented env stubs to `.env` for the providers a spec
 * needs but the environment lacks. Commented (so nothing is accidentally set
 * to a placeholder) and idempotent: a var already present in `.env` (set OR
 * commented) is skipped. Returns undefined when there is nothing to append.
 *
 * `neededVars` is the ordered list of env var names to stub (the caller derives
 * these from the failing credential checks); each becomes a `# NAME=` line
 * under a generated header, appended to the existing `.env` (created if
 * absent).
 */
export function planEnvStubs(opts: {
  readonly fs: FixFs;
  readonly envPath: string;
  readonly neededVars: readonly string[];
}): FixAction | undefined {
  if (opts.neededVars.length === 0) return undefined;
  const existing = opts.fs.exists(opts.envPath) ? opts.fs.read(opts.envPath) : "";
  // A var is "present" if any line names it as a key, set or commented:
  //   NAME=...        or        # NAME=...
  const present = new Set<string>();
  for (const rawLine of existing.split("\n")) {
    const m = /^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(rawLine);
    if (m?.[1] !== undefined) present.add(m[1]);
  }
  const toAdd = opts.neededVars.filter((v) => !present.has(v));
  if (toAdd.length === 0) return undefined;
  const header = "# added by `crewhaus doctor --fix` — fill in and uncomment";
  const stubLines = [header, ...toAdd.map((v) => `# ${v}=`)];
  const stubBlock = stubLines.join("\n");
  const needsLeadingNewline = existing !== "" && !existing.endsWith("\n");
  const appended = `${existing}${needsLeadingNewline ? "\n" : ""}${stubBlock}\n`;
  return {
    check: "provider credentials",
    summary: `append ${toAdd.length} commented env stub(s) to ${opts.envPath}`,
    diff: [`~ ${opts.envPath}:`, ...stubLines.map((l) => `+ ${l}`)].join("\n"),
    apply: () => opts.fs.write(opts.envPath, appended),
  };
}

/** Format a plan (dry-run or applied) as the `--fix` report block. */
export function formatFixPlan(actions: readonly FixAction[], applied: boolean): string {
  if (actions.length === 0) {
    return applied
      ? "doctor --fix: nothing to fix — all mechanical checks already clean.\n"
      : "doctor --fix (dry-run): nothing to fix — all mechanical checks already clean.\n";
  }
  const lines: string[] = [];
  lines.push(
    applied
      ? `doctor --fix: applied ${actions.length} fix(es):`
      : `doctor --fix (dry-run): ${actions.length} fix(es) available — re-run with --fix to apply:`,
  );
  for (const a of actions) {
    lines.push("");
    lines.push(`  [${a.check}] ${a.summary}`);
    for (const dl of a.diff.split("\n")) lines.push(`    ${dl}`);
  }
  return `${lines.join("\n")}\n`;
}
