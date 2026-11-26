/**
 * The one check pipeline: every stage `crewhaus lint` and `checkSpec` share,
 * run once over a spec's text, with each stage's raw outcome returned.
 *
 * `checkSpec` turns the outcome into one result object; `crewhaus lint` turns
 * it into findings, with its own stages (the narrowing lists, the tool-scope
 * audit against the live tools, the permission rules and the provability
 * rules) placed between these in the order its findings have always had.
 * Neither re-runs a stage, so the two cannot drift.
 *
 * The stages, in order:
 *   1. parse: `parseSpec`, and on failure its message plus `parseSpecIssues`'
 *      full list (every schema issue, or every cross-field issue);
 *   2. lower: `lowerWithWarnings`, with `today` threaded so a sunset check
 *      reads a pinned date;
 *   3. every IR pass of `DEFAULT_PIPELINE`, each on its own (collect-all:
 *      one pass's violation never hides another's);
 *   4. the compiler's per-shape tool check (`checkShapeTools`);
 *   5. the spec-key warnings `crewhaus compile` prints
 *      (`collectCompileWarnings`);
 *   6. a declared `mcp_servers.thredz` beside a `thredz:` block;
 *   7. the ambiguous `mcp_servers` names (`mcpServerNameWarnings`);
 *   8. the model-plan checks (`auditModelPlan`);
 *   9. a spending period below the per-run cap.
 * The lowering's own warnings (the `provability-*` ones lint reports, a model
 * sunset, …) are returned as they came.
 *
 * Synchronous, and never throws: a parse or lowering failure ends the run
 * with what was learned, and a stage that throws unexpectedly is recorded in
 * `failures` rather than thrown. Nothing here reads a file, the network, a
 * registry or (with `today` set) the clock.
 */
import {
  type CompileWarning,
  type IrNode,
  checkShapeTools,
  collectCompileWarnings,
  lowerWithWarnings,
} from "@crewhaus/compiler";
import { CrewhausError } from "@crewhaus/errors";
import { DEFAULT_PIPELINE, type IrPass } from "@crewhaus/ir-passes";
import {
  type Spec,
  type SpecIssue,
  SpecParseError,
  mcpServerNameWarnings,
  parseSpec,
  parseSpecIssues,
} from "@crewhaus/spec";
import { type ModelPlanFinding, auditModelPlan } from "./model-plan-lint";

/** A finding a stage reports at a spec path. */
export type StageNote = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

export type CheckStagesOptions = {
  /** Pins the date the model-sunset checks read (`YYYY-MM-DD`). */
  readonly today?: string;
  /** The IR passes to run, each on its own. Default `DEFAULT_PIPELINE`. */
  readonly passes?: ReadonlyArray<IrPass>;
};

/** What every shared stage found. A stage that did not run reports nothing. */
export type CheckStages = {
  /** The parsed spec, when it parsed. */
  readonly spec?: Spec;
  /** The lowered IR, when it lowered. */
  readonly ir?: IrNode;
  /** Why the spec did not parse: `parseSpec`'s message and every issue. */
  readonly parseFailure?: { readonly message: string; readonly issues: ReadonlyArray<SpecIssue> };
  /** Why the parsed spec did not lower. */
  readonly lowerFailure?: { readonly message: string };
  /** The lowering's own warnings, as `lowerWithWarnings` returned them. */
  readonly loweredWarnings: ReadonlyArray<CompileWarning>;
  /** One finding per IR pass that refused the IR, in pipeline order. */
  readonly passFindings: ReadonlyArray<{ readonly pass: string; readonly message: string }>;
  /** The compiler's per-shape tool check. */
  readonly shapeTools: {
    readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>;
    readonly warnings: ReadonlyArray<CompileWarning>;
  };
  /** The spec-key warnings `crewhaus compile` prints. */
  readonly compileWarnings: ReadonlyArray<CompileWarning>;
  /** A user-declared `mcp_servers.thredz` that wins over the `thredz:` block's. */
  readonly thredzOverride?: StageNote;
  /** `mcp_servers` names that make a tool name ambiguous. */
  readonly mcpServerNames: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  /** The model-plan checks over the lowered IR. */
  readonly modelPlan: ReadonlyArray<ModelPlanFinding>;
  /** A spending period below the per-run cap: valid, and worth knowing. */
  readonly budgetPeriod?: StageNote;
  /** A stage that threw when it should not have, with what it threw. */
  readonly failures: ReadonlyArray<{ readonly stage: string; readonly error: unknown }>;
};

const NO_TOOLS = { errors: [], warnings: [] } as const;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run every shared stage once over `yamlText`. Never throws. */
export function runCheckStages(yamlText: string, opts: CheckStagesOptions = {}): CheckStages {
  const failures: Array<{ stage: string; error: unknown }> = [];
  const empty = {
    loweredWarnings: [],
    passFindings: [],
    shapeTools: NO_TOOLS,
    compileWarnings: [],
    mcpServerNames: [],
    modelPlan: [],
    failures,
  };

  // 1 — parse. A failure is terminal: without a spec there is nothing to lower.
  let spec: Spec;
  try {
    spec = parseSpec(yamlText);
  } catch (err) {
    const message = err instanceof SpecParseError ? err.message : messageOf(err);
    let issues: ReadonlyArray<SpecIssue>;
    try {
      issues = parseSpecIssues(yamlText);
    } catch (issuesErr) {
      failures.push({ stage: "parse", error: issuesErr });
      issues = [];
    }
    return { ...empty, parseFailure: { message, issues } };
  }

  // 2 — lower. A failure (a `CompilerError`, such as a malformed credential
  // reference) is terminal too: the IR stages need the IR.
  let ir: IrNode;
  let loweredWarnings: ReadonlyArray<CompileWarning>;
  try {
    const lowered = lowerWithWarnings(spec, opts.today !== undefined ? { today: opts.today } : {});
    ir = lowered.ir;
    loweredWarnings = lowered.warnings;
  } catch (err) {
    const message = err instanceof CrewhausError ? err.message : messageOf(err);
    return { ...empty, spec, lowerFailure: { message } };
  }

  const guarded = <T>(stage: string, run: () => T, fallback: T): T => {
    try {
      return run();
    } catch (err) {
      failures.push({ stage, error: err });
      return fallback;
    }
  };

  // 3 — the IR passes, collect-all. Validating passes throw on a violation;
  // rewriting passes never throw, and their output is discarded.
  const passFindings: Array<{ pass: string; message: string }> = [];
  for (const pass of opts.passes ?? DEFAULT_PIPELINE) {
    try {
      pass(ir);
    } catch (err) {
      const message = err instanceof CrewhausError ? err.message : messageOf(err);
      passFindings.push({ pass: pass.name || "anonymous", message });
    }
  }

  // 4–5 — the compiler's own tool check and spec-key warnings.
  const shapeTools = guarded("tools", () => checkShapeTools(ir), NO_TOOLS);
  const compileWarnings = guarded("compile-warnings", () => collectCompileWarnings(spec), []);

  // 6 — a user-declared `mcp_servers.thredz` next to a `thredz:` block wins
  // over the compiler's synthesis (explicit beats implicit), which is worth
  // saying so nobody wonders why the block's knobs stopped applying.
  const specThredz = (spec as { thredz?: unknown }).thredz;
  const specMcp = (spec as { mcp_servers?: Record<string, unknown> }).mcp_servers;
  const thredzOverride: StageNote | undefined =
    specThredz !== undefined && specThredz !== false && specMcp?.["thredz"] !== undefined
      ? {
          code: "thredz-override",
          path: "mcp_servers.thredz",
          message:
            "mcp_servers.thredz is user-declared, so the thredz: block does not synthesize a server — your explicit entry wins (explicit beats implicit). The thredz: knobs still drive the wiring (aliases, goal mirror), but api_key/base_url/visibility only apply through YOUR server's env; it must speak the thredz-mcp v0.2.0 tool contract.",
        }
      : undefined;

  // 7–8 — ambiguous MCP server names; the model-plan checks.
  const mcpServerNames = guarded("mcp-server-names", () => mcpServerNameWarnings(spec), []);
  const modelPlan = guarded("model-plan", () => auditModelPlan(ir), []);

  // 9 — a spending period below the per-run cap ends a run before its own cap.
  const budget = "budget" in spec ? spec.budget : undefined;
  const budgetPeriod: StageNote | undefined =
    budget?.period !== undefined && budget.period.usd < budget.usd
      ? {
          code: "budget-period-below-run-cap",
          path: "budget.period.usd",
          message: `budget.period.usd ($${budget.period.usd}) is below budget.usd ($${budget.usd}), so a run can use up the period's limit before it reaches its own cap.`,
        }
      : undefined;

  return {
    spec,
    ir,
    loweredWarnings,
    passFindings,
    shapeTools,
    compileWarnings,
    ...(thredzOverride !== undefined ? { thredzOverride } : {}),
    mcpServerNames,
    modelPlan,
    ...(budgetPeriod !== undefined ? { budgetPeriod } : {}),
    failures,
  };
}
