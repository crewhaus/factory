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

  // Stage 5 — v0.3.0 Goal 3 (design §4.1): a user-declared
  // `mcp_servers.thredz` next to a `thredz:` block WINS over the compiler's
  // synthesis (explicit beats implicit). That is deliberate — the vendored
  // -server escape hatch — but worth a warning so nobody wonders why their
  // `base_url`/`visibility` knobs stopped applying.
  const specThredz = (spec as { thredz?: unknown }).thredz;
  const specMcp = (spec as { mcp_servers?: Record<string, unknown> }).mcp_servers;
  if (specThredz !== undefined && specThredz !== false && specMcp?.["thredz"] !== undefined) {
    findings.push({
      message:
        "mcp_servers.thredz is user-declared, so the thredz: block does not synthesize a server — your explicit entry wins (explicit beats implicit). The thredz: knobs still drive the wiring (aliases, goal mirror), but api_key/base_url/visibility only apply through YOUR server's env; it must speak the thredz-mcp v0.2.0 tool contract.",
      path: "mcp_servers.thredz",
      severity: "warning",
      rule: "thredz-override",
    });
  }

  // Warnings inform; only errors gate (`ok` drives the CLI exit code).
  return { ok: findings.every((f) => f.severity !== "error"), findings, spec, ir };
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
 * The outcome of a nearest-match lookup:
 *  - `undefined` — no candidate close enough (genuinely unknown, not a typo),
 *    or the name is already legal.
 *  - `{ kind: "match", name }` — a single unambiguous nearest candidate;
 *    safe to auto-apply.
 *  - `{ kind: "ambiguous", candidates }` — two or more equally-near
 *    candidates whose I/O capability DIFFERS (e.g. a read-only tool vs a
 *    mutating one), so auto-applying could silently cross a capability
 *    boundary. Callers should surface this as a suggestion, not a fix.
 */
export type NearestToolMatch =
  | { readonly kind: "match"; readonly name: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

/**
 * Nearest legal name(s) for a mistyped tool name. `candidates` is the union of
 * the legal spellings — the camelCase BUILTIN_TOOL_MAP keys AND the registered
 * PascalCase names (both forms are legal in a spec: top-level `tools:` uses the
 * camelCase key; a sub-agent `tools:` uses the PascalCase registered name). An
 * exact match returns undefined (nothing to fix). Otherwise the closest
 * candidate(s) within `maxDistance` (default 3) are considered; undefined
 * means nothing is close enough (a genuinely unknown tool, not a typo).
 *
 * `getReadOnly` is an optional injected lookup from candidate name → the
 * resolved tool's `readOnly` flag (undefined when the candidate can't be
 * resolved to a RegisteredTool, e.g. an unregistered custom-tool name — in
 * that case its capability is unknown and it is never treated as crossing a
 * boundary against another candidate). When ALL of the closest candidates
 * (same minimum distance) agree on `readOnly` — including the degenerate
 * single-candidate case — this returns a `"match"` for the first of them
 * (stable, deterministic). When they DISAGREE — a typo equidistant from a
 * read-only tool (e.g. `Read`) and a mutating one (e.g. `Edit`) — this
 * returns `"ambiguous"` with the full tied set rather than silently picking
 * one, because auto-applying would cross a read-only/mutating capability
 * boundary the author never asked for.
 */
export function nearestToolName(
  name: string,
  candidates: readonly string[],
  maxDistance = 3,
  getReadOnly?: (candidateName: string) => boolean | undefined,
): NearestToolMatch | undefined {
  if (candidates.includes(name)) return undefined;
  let bestDist: number | undefined;
  let tied: string[] = [];
  for (const cand of candidates) {
    const dist = levenshtein(name, cand);
    if (bestDist === undefined || dist < bestDist) {
      bestDist = dist;
      tied = [cand];
    } else if (dist === bestDist) {
      tied.push(cand);
    }
  }
  if (bestDist === undefined || bestDist > maxDistance) return undefined;
  if (tied.length === 1) {
    const only = tied[0];
    if (only === undefined) return undefined;
    return { kind: "match", name: only };
  }
  // Multiple equally-near candidates. If a capability lookup was injected and
  // the tied set spans more than one `readOnly` value, that is a genuine
  // cross-capability ambiguity — refuse to pick one. Candidates with unknown
  // capability (getReadOnly returns undefined) don't by themselves create
  // ambiguity: they only conflict when they disagree with a KNOWN capability
  // among the tied set.
  if (getReadOnly !== undefined) {
    const knownCapabilities = new Set(
      tied.map((c) => getReadOnly(c)).filter((v): v is boolean => v !== undefined),
    );
    if (knownCapabilities.size > 1) {
      return { kind: "ambiguous", candidates: tied };
    }
  } else {
    // No capability signal available — a plain tie is still ambiguous rather
    // than silently guessing via iteration order.
    return { kind: "ambiguous", candidates: tied };
  }
  const first = tied[0];
  if (first === undefined) return undefined;
  return { kind: "match", name: first };
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
