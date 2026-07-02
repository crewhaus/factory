import { type IrNode, lower } from "@crewhaus/compiler";
import { CrewhausError } from "@crewhaus/errors";
import { DEFAULT_PIPELINE, type IrPass } from "@crewhaus/ir-passes";
import { type Spec, SpecParseError, parseSpec } from "@crewhaus/spec";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { auditSpecToolNames, collectToolNames } from "./scope-audit";

/**
 * Item 41 — `crewhaus lint`. A check-only command: `parseSpec` +
 * `compile({ applyIrPasses: true })` (the §47 chain / graph-crew
 * well-formedness passes) + `auditToolScopes`, WITHOUT emitting a bundle.
 *
 * WHY THIS EXISTS: the CLI compile path never applied the ir-passes today, so
 * §47 referential-integrity and graph/crew well-formedness checks silently
 * skipped for CLI users — a spec with a dangling `wallets[].chainId` or an
 * unreachable graph node compiled clean. `lint` runs those passes (discarding
 * the result) so authoring bugs surface without a build.
 *
 * COLLECT-ALL vs FAIL-FAST: the IR passes throw on the FIRST violation. For
 * `--format text` that fail-fast is fine (one error, fix, re-run). For
 * `--format json` (editors/CI) we want as many findings as possible, so we run
 * each pass INDEPENDENTLY and catch-and-continue — collecting at most one
 * finding per pass. That is the honest limit of an exception-based pass API
 * (a single pass still stops at its own first violation); it is documented
 * here and surfaced as `severity: "error"` findings with a stable `path`.
 *
 * Side-effect-free: `runLint` is a pure function over the spec text plus an
 * injected tool resolver (so tests don't import the heavy tool packages). The
 * CLI wrapper owns file IO and process exit.
 */

export type LintSeverity = "error" | "warning";

/** One structured finding. `path` is a dot-joined spec/IR location (or a
 *  synthetic id for whole-spec failures); shaped for editor/CI consumption. */
export type LintFinding = {
  readonly message: string;
  readonly path: string;
  readonly severity: LintSeverity;
  /** Stable rule id (parse | ir-pass:<name> | scope | …) for grouping. */
  readonly rule: string;
};

export type LintResult = {
  readonly ok: boolean;
  readonly findings: readonly LintFinding[];
  /** The parsed spec when parse succeeded (so --fix can operate on it). */
  readonly spec?: Spec;
  /** The lowered IR when lowering succeeded. */
  readonly ir?: IrNode;
};

/**
 * Run the lint pipeline. `resolveTool` maps a tool NAME (either the camelCase
 * spec key or its registered PascalCase name) to a `RegisteredTool`, or
 * undefined — injected so this stays pure. `passes` defaults to the published
 * `DEFAULT_PIPELINE` and is overridable for tests.
 */
export function runLint(
  yamlText: string,
  resolveTool: (name: string) => RegisteredTool | undefined,
  passes: ReadonlyArray<IrPass> = DEFAULT_PIPELINE,
): LintResult {
  const findings: LintFinding[] = [];

  // Stage 1 — parse. A parse failure is terminal: without a spec there is
  // nothing to lower or audit.
  let spec: Spec;
  try {
    spec = parseSpec(yamlText);
  } catch (err) {
    const message = err instanceof SpecParseError ? err.message : (err as Error).message;
    findings.push({ message, path: "<spec>", severity: "error", rule: "parse" });
    return { ok: false, findings };
  }

  // Stage 2 — lower. lower() can throw CompilerError (e.g. a malformed
  // credential env-ref); treat as terminal for the IR-pass stage.
  let ir: IrNode;
  try {
    ir = lower(spec);
  } catch (err) {
    const message = err instanceof CrewhausError ? err.message : (err as Error).message;
    findings.push({ message, path: "<lower>", severity: "error", rule: "lower" });
    return { ok: false, findings, spec };
  }

  // Stage 3 — IR passes, COLLECT-ALL. Run each pass independently so one pass's
  // violation doesn't hide the others'. Validating passes
  // (transactionPolicyEnforcement, wellFormednessCheck) throw IrPassError; the
  // rewriting passes are pure and never throw. We discard rewritten IR (lint
  // never emits) — only the thrown violations matter.
  for (const pass of passes) {
    try {
      pass(ir);
    } catch (err) {
      const message = err instanceof CrewhausError ? err.message : (err as Error).message;
      findings.push({
        message,
        path: `ir-pass:${pass.name || "anonymous"}`,
        severity: "error",
        rule: `ir-pass:${pass.name || "anonymous"}`,
      });
    }
  }

  // Stage 4 — tool-scope audit over the IR's tool names, sharing the exact
  // gate `compile --strict` uses. A resolvable built-in is audited by
  // capability/scope; an outward-by-name sink that resolves to no external
  // tool is a finding.
  const toolNames = collectToolNames(ir);
  const scopeFindings = auditSpecToolNames(toolNames, resolveTool);
  for (const f of scopeFindings) {
    findings.push({
      message: `tool "${f.toolName}" ${f.reason}`,
      path: `tools.${f.toolName}`,
      severity: "error",
      rule: "scope",
    });
  }

  return { ok: findings.length === 0, findings, spec, ir };
}

/** Re-exported for the CLI wrapper's philosophy-alignment parity note. */
export { auditToolScopes };

// -------------------------------------------------------------------------
// --fix: mechanical corrections for the findings a nearest-match / typo scan
// can resolve. Pure suggesters; the CLI wrapper applies chosen edits via
// spec-patch.
// -------------------------------------------------------------------------

/** A single mechanical fix suggestion for a lint finding. */
export type LintFixSuggestion = {
  readonly kind: "unknown-tool" | "secret-typo" | "safe-name";
  /** The offending token as written in the spec. */
  readonly from: string;
  /** The suggested replacement. */
  readonly to: string;
  /** Human-readable one-liner. */
  readonly note: string;
};

/** Case-insensitive Levenshtein distance — the nearest-match metric. */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/**
 * Nearest legal name for a mistyped tool name. `candidates` is the union of the
 * legal spellings — the camelCase BUILTIN_TOOL_MAP keys AND the registered
 * PascalCase names (both forms are legal in a spec: top-level `tools:` uses the
 * camelCase key; a sub-agent `tools:` uses the PascalCase registered name). An
 * exact match returns undefined (nothing to fix). Otherwise the closest
 * candidate within `maxDistance` (default 3) is returned, or undefined when
 * nothing is close enough (a genuinely unknown tool, not a typo).
 */
export function nearestToolName(
  name: string,
  candidates: readonly string[],
  maxDistance = 3,
): string | undefined {
  if (candidates.includes(name)) return undefined;
  let best: { name: string; dist: number } | undefined;
  for (const cand of candidates) {
    const dist = levenshtein(name, cand);
    if (best === undefined || dist < best.dist) best = { name: cand, dist };
  }
  if (best === undefined || best.dist > maxDistance) return undefined;
  return best.name;
}

/**
 * Suggest a `$UPPER_SNAKE_CASE` correction for a credential value that looks
 * like an env reference but isn't a valid one — the same class the compiler's
 * `lowerCredential` rejects (`$slack_token`, `${SLACK}`, `$1PASSWORD`).
 * Returns the normalised form, or undefined when `value` is not a
 * malformed-env-ref (a genuine literal, or already valid). Pure string logic.
 */
export function suggestSecretFix(value: string): string | undefined {
  if (!value.startsWith("$")) return undefined;
  // Already valid $UPPER_SNAKE_CASE — nothing to fix.
  if (/^\$[A-Z_][A-Z0-9_]*$/.test(value)) return undefined;
  // Strip a ${...} brace wrapper, then normalise the inner token.
  const inner = value.replace(/^\$\{?/, "").replace(/\}$/, "");
  if (inner === "") return undefined;
  // UPPER_SNAKE_CASE it: non-alnum → _, then uppercase, then ensure it does
  // not start with a digit (prefix `_`).
  let normalised = inner.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  if (/^[0-9]/.test(normalised)) normalised = `_${normalised}`;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalised)) return undefined;
  return `$${normalised}`;
}

/** The single-line-safe name charset the spec's `safeName` enforces. */
const SAFE_NAME_RE = /^[\w .:-]+$/;

/**
 * Normalise a name that violates the `safeName` charset (letters, digits,
 * spaces, `_ . - :`) by replacing every illegal character with `-` and
 * collapsing runs. Returns undefined when `name` is already safe. Pure.
 */
export function suggestSafeName(name: string): string | undefined {
  if (SAFE_NAME_RE.test(name) && name.length >= 1) return undefined;
  const fixed = name
    .replace(/[^\w .:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
  if (fixed === "" || !SAFE_NAME_RE.test(fixed)) return undefined;
  return fixed;
}

/** Render the lint findings as the human-readable `text` report. Returns the
 *  block plus whether it is clean, so the CLI can pick the exit code. */
export function formatLintText(result: LintResult): string {
  if (result.findings.length === 0) return "lint: clean — no findings.\n";
  const lines: string[] = [];
  for (const f of result.findings) {
    const marker = f.severity === "error" ? "✗" : "~";
    lines.push(`${marker} [${f.rule}] ${f.path}: ${f.message}`);
  }
  const errorCount = result.findings.filter((f) => f.severity === "error").length;
  lines.push("");
  lines.push(`lint: ${errorCount} error(s), ${result.findings.length - errorCount} warning(s).`);
  return `${lines.join("\n")}\n`;
}

/** Render the lint findings as `{ findings: LintFinding[] }` JSON for editors/CI. */
export function formatLintJson(result: LintResult): string {
  return `${JSON.stringify({ ok: result.ok, findings: result.findings }, null, 2)}\n`;
}
