import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrWorkflowStep,
  type IrWorkflowV0,
  renderBundleReadme,
} from "@crewhaus/ir";

/**
 * Emit a self-contained workflow agent bundle. The generated agent.ts
 * runs each step sequentially via runChatLoop in single-turn mode. Step
 * 1 reads its initial user message from process.stdin (read to EOF);
 * steps 2+ have no user input — they receive a synthetic user message
 * containing the prior step's terminal assistant text.
 *
 * Loop contract 0.4 (Batch A): the spec's `limits` ceilings thread into
 * every step's call — `deadline_ms` bounds the WHOLE run (the runner
 * stamps the deadline once, guards between steps, and arms each step's
 * runtime deadline timer with the remaining budget) while
 * `turn_timeout_ms` bounds one step. Each step carries its own
 * `max_tokens`/`thinking` tuning, `budget` and the spec-declared `hooks`
 * ride along, and `mcp_servers` are wired for real (G05): one shared
 * McpHost boots before the steps and its tools flow to every step that
 * declares tools.
 *
 * Loop contract 0.4 (Batch B, G02) — `kind: "judge"` steps are emitted as
 * JUDGE GATES over the previous non-judge step's output:
 *
 *   - The gate scores `priorOutput` in [0,1] against the judge criteria
 *     via `@crewhaus/eval-judge` (forced-tool scoring, single-criterion
 *     rubric, `(n − 1) / 4` mapping — the createJudgeGrader convention)
 *     on the judge step's resolved `model`.
 *   - Every scoring pass publishes a `judge_verdict` trace event on the
 *     bundle's shared RunContext bus and prints a `[judge <name>]` line.
 *   - `on_fail: retry_previous` re-runs the gated step with the judge
 *     rationale appended to its instructions as a system nudge, at most
 *     `maxRetries` times; a still-failing gate then stops the run
 *     CLASSIFIED (fail-closed — the loop projection's outgoing edge only
 *     fires on "pass"). `halt` stops classified immediately; `continue`
 *     records the verdict and proceeds with the flagged output.
 *   - Gated steps are emitted as re-invocable closures with their input
 *     captured BEFORE the first run, so a retry replays the exact same
 *     user content (not the step's own output).
 *
 * v0 honesty notes (mirrors the per-step `budget` meter caveat): judge
 * model calls ride OUTSIDE the per-step budget meter and the runtime
 * deadline timers (eval-judge drives the provider adapter directly), and
 * in a judge CHAIN a retry re-scores only the retrying judge — earlier
 * judges' verdicts refer to the previous attempt.
 *
 * Future expansion: parallel/conditional steps, fan-out — this v0 emits
 * strictly sequential execution.
 */
export function emitWorkflow(ir: IrWorkflowV0, opts: EmitReadmeOptions = {}): Bundle {
  const files = [
    {
      path: "agent.ts",
      content: renderAgent(ir),
    },
  ];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Built-in tool name → package + export. Mirrors the same map in
 * @crewhaus/target-cli; intentionally duplicated for this PR. Follow-up
 * will extract a shared @crewhaus/tool-resolver package.
 */
const BUILTIN_TOOL_MAP: Record<string, { package: string; export: string }> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite" },
  // §47 read-only EVM tools (slice 0).
  evmCall: { package: "@crewhaus/tool-evm", export: "evmCall" },
  evmGetLogs: { package: "@crewhaus/tool-evm", export: "evmGetLogs" },
  evmGetTransaction: { package: "@crewhaus/tool-evm", export: "evmGetTransaction" },
  evmGetTransactionReceipt: {
    package: "@crewhaus/tool-evm",
    export: "evmGetTransactionReceipt",
  },
  evmGetBalance: { package: "@crewhaus/tool-evm", export: "evmGetBalance" },
  evmBlockNumber: { package: "@crewhaus/tool-evm", export: "evmBlockNumber" },
  // §47 destructive EVM tools (slice 1) — gated by permission-engine
  // (destructive: true) and wallet-engine (two-gate model).
  evmSendTransaction: { package: "@crewhaus/tool-evm-tx", export: "evmSendTransaction" },
  evmSimulate: { package: "@crewhaus/tool-evm-tx", export: "evmSimulate" },
};

/**
 * Compute the union of every tool referenced across all steps and resolve
 * to grouped imports (sorted, one per package). Throws TargetEmitError if
 * any step references an unknown tool name.
 */
function resolveAllTools(steps: readonly IrWorkflowStep[]): string[] {
  const seen = new Set<string>();
  for (const step of steps) {
    for (const t of step.tools) seen.add(t);
  }
  if (seen.size === 0) return [];

  const byPackage = new Map<string, string[]>();
  for (const name of seen) {
    const entry = BUILTIN_TOOL_MAP[name];
    if (!entry) {
      const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
      throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
    }
    const list = byPackage.get(entry.package) ?? [];
    list.push(entry.export);
    byPackage.set(entry.package, list);
  }

  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const exports = (byPackage.get(pkg) ?? []).slice().sort();
    imports.push(`import { ${exports.join(", ")} } from "${pkg}";`);
  }
  return imports;
}

/**
 * Loop contract 0.4 (Batch B, G02) — is this step a judge gate? The IR
 * contract sets `judge` iff `kind === "judge"`; both are checked so a
 * malformed direct-IR step falls through to the regular renderer (and the
 * judge renderer's own guard) instead of emitting a half-gate.
 */
function isJudgeStep(step: IrWorkflowStep): boolean {
  return step.kind === "judge" && step.judge !== undefined;
}

/**
 * Loop contract 0.4 (Batch B, G02) — index of the step a judge at
 * `judgeIdx` gates: the NEAREST earlier non-judge step. Judge steps pass
 * `priorOutput` through untouched, so consecutive judges all gate the
 * same upstream output (two quality bars on one artifact). parseSpec
 * rejects `steps[0]` as a judge; this re-checks for direct emitWorkflow
 * callers (same convention as target-graph's validateGraph).
 */
function gatedStepIndex(steps: readonly IrWorkflowStep[], judgeIdx: number): number {
  for (let i = judgeIdx - 1; i >= 0; i -= 1) {
    const s = steps[i];
    if (s !== undefined && !isJudgeStep(s)) return i;
  }
  throw new TargetEmitError(
    `judge step "${steps[judgeIdx]?.name ?? judgeIdx}" has no earlier non-judge step to gate — a judge cannot be the first step`,
  );
}

/**
 * Fields shared verbatim by every step's runChatLoop call, precomputed
 * once in renderAgent. `hooksExpr` is `__allHooks` when the spec declares
 * `hooks:` (concat with the discovered settings.json hooks), else the
 * pre-existing `__hooks`. `deadlineMs` renders the per-step whole-run
 * deadline guard; `mcpWired` spreads `__mcpTools` into tool-declaring
 * steps (G05). `runContextLine` threads the shared `__runContext` into
 * every call when the workflow carries judge steps (G02) — one bus for
 * step traces and judge verdicts — and is empty otherwise so judge-free
 * bundles stay byte-identical.
 */
type StepShared = {
  readonly permFields: string;
  readonly failureTaxonomyField: string;
  readonly limitsFields: string;
  readonly budgetField: string;
  readonly hooksExpr: string;
  readonly deadlineMs: number | undefined;
  readonly mcpWired: boolean;
  readonly runContextLine: string;
};

function renderStep(step: IrWorkflowStep, idx: number, total: number, shared: StepShared): string {
  const isFirst = idx === 0;
  const stepNum = idx + 1;
  const toolsField = renderStepToolsField(step.tools, shared.mcpWired);
  const stepTuningFields = renderStepTuningFields(step);
  const deadlineGuard = renderDeadlineGuard(shared.deadlineMs, stepNum, total, step.name);

  // Anthropic rejects empty user content with a 400, so fall back to a
  // non-empty placeholder when stdin is empty (autonomous-style agent —
  // the step's instructions ARE the prompt).
  const userContent = isFirst
    ? 'stdinInput || "begin"'
    : "`## Output of previous step:\\n${priorOutput}\\n\\n## Your task:\\n(continue based on the previous step's output)`";

  const stdinReadLine = isFirst ? "  const stdinInput = await readStdinToEnd();\n" : "";

  return `
  // ── Step ${stepNum}/${total}: ${step.name} ──
${deadlineGuard}${stdinReadLine}  process.stdout.write("\\n[step ${stepNum}/${total}: ${step.name}]\\n");
  priorOutput = await runChatLoop({
    model: ${escapeJsonString(step.model)},
    instructions: ${escapeJsonString(step.instructions)},
    singleTurn: true,
    seedMessages: [{ role: "user", content: ${userContent} }],${toolsField}${stepTuningFields}${shared.limitsFields}${shared.budgetField}${shared.permFields}${shared.failureTaxonomyField}
    hooks: ${shared.hooksExpr},
    skills: __skills,
    slashCommands: __slashCommands,${shared.runContextLine}
  });
`;
}

/**
 * Loop contract 0.4 (Batch B, G02) — render a step that a downstream
 * judge gates. Identical to {@link renderStep} except the user input is
 * captured into a const BEFORE the first run (a retry must replay the
 * step's ORIGINAL input, not the output it just produced) and the
 * runChatLoop call is wrapped in a re-invocable closure taking the judge
 * nudge; the nudge is appended to the step's instructions (seed roles are
 * user/assistant only, so "system nudge" = instructions suffix).
 */
function renderGatedStep(
  step: IrWorkflowStep,
  idx: number,
  total: number,
  shared: StepShared,
): string {
  const isFirst = idx === 0;
  const stepNum = idx + 1;
  const toolsField = renderStepToolsField(step.tools, shared.mcpWired);
  const stepTuningFields = renderStepTuningFields(step);
  const deadlineGuard = renderDeadlineGuard(shared.deadlineMs, stepNum, total, step.name);
  const inputExpr = isFirst
    ? 'stdinInput || "begin"'
    : "`## Output of previous step:\\n${priorOutput}\\n\\n## Your task:\\n(continue based on the previous step's output)`";
  const stdinReadLine = isFirst ? "  const stdinInput = await readStdinToEnd();\n" : "";

  return `
  // ── Step ${stepNum}/${total}: ${step.name} ──
${deadlineGuard}${stdinReadLine}  process.stdout.write(${escapeJsonString(`\n[step ${stepNum}/${total}: ${step.name}]\n`)});
  // Judge-gated (loop contract 0.4, G02): input captured up front, call
  // wrapped in a closure so the gate can re-run this step with the judge
  // rationale appended as a nudge (bounded by the judge's max_retries).
  const __step${stepNum}Input = ${inputExpr};
  const __runStep${stepNum} = async (__nudge: string): Promise<string> => runChatLoop({
    model: ${escapeJsonString(step.model)},
    instructions: ${escapeJsonString(step.instructions)} + __nudge,
    singleTurn: true,
    seedMessages: [{ role: "user", content: __step${stepNum}Input }],${toolsField}${stepTuningFields}${shared.limitsFields}${shared.budgetField}${shared.permFields}${shared.failureTaxonomyField}
    hooks: ${shared.hooksExpr},
    skills: __skills,
    slashCommands: __slashCommands,${shared.runContextLine}
  });
  priorOutput = await __runStep${stepNum}("");
`;
}

/**
 * Loop contract 0.4 (Batch B, G02) — render a judge step. The gate scores
 * `priorOutput` (the gated step's output — judges pass it through
 * untouched) with the generated `__judgeGate` helper, publishes ONE
 * `judge_verdict` trace event per scoring pass, prints a `[judge <name>]`
 * line, then applies the resolved `onFail`:
 *
 *   - `retry_previous`: re-invoke the gated step's closure with the
 *     rationale nudge, at most `maxRetries` times; retries exhausted with
 *     the gate still failing stops the run classified (fail-closed — the
 *     projection's outgoing edge fires only on "pass").
 *   - `halt`: publish `run_failed` (the graph-engine G69 convention) and
 *     throw the classified RunFailedError immediately.
 *   - `continue`: print the flagged-output note and proceed.
 *
 * Every emit-time string that reaches executable code threads through
 * escapeJsonString — judge/step names and criteria are user-controlled.
 */
function renderJudgeStep(
  step: IrWorkflowStep,
  idx: number,
  steps: readonly IrWorkflowStep[],
  total: number,
  shared: StepShared,
): string {
  const gate = step.judge;
  if (gate === undefined) {
    throw new TargetEmitError(
      `judge step "${step.name}" carries no judge config — kind: "judge" requires a judge block`,
    );
  }
  const stepNum = idx + 1;
  const gIdx = gatedStepIndex(steps, idx);
  const gated = steps[gIdx] as IrWorkflowStep;
  const gatedNum = gIdx + 1;
  const deadlineGuard = renderDeadlineGuard(shared.deadlineMs, stepNum, total, step.name);
  const header = `
  // ── Step ${stepNum}/${total}: ${step.name} (judge — gates step ${gatedNum}/${total}: ${gated.name}) ──
${deadlineGuard}  process.stdout.write(${escapeJsonString(`\n[step ${stepNum}/${total}: ${step.name} (judge)]\n`)});
`;
  const scoringPass = (i: string): string =>
    [
      `${i}const __result = await __judgeGate({`,
      `${i}  criteria: ${escapeJsonString(gate.criteria)},`,
      `${i}  model: ${escapeJsonString(step.model)},`,
      `${i}  gatedTask: ${escapeJsonString(gated.instructions)},`,
      `${i}  output: priorOutput,`,
      `${i}});`,
      `${i}const __pass = __result.score >= ${gate.threshold};`,
      `${i}const __bus = __runContext.eventBus;`,
      `${i}__bus.publish({`,
      `${i}  ...__bus.envelope(),`,
      `${i}  kind: "judge_verdict",`,
      `${i}  stepOrNode: ${escapeJsonString(step.name)},`,
      `${i}  verdict: __pass ? "pass" : "fail",`,
      `${i}  score: __result.score,`,
      `${i}  ...(__result.rationale.length > 0 ? { rationale: __result.rationale } : {}),`,
      `${i}});`,
      `${i}process.stdout.write(${escapeJsonString(`[judge ${step.name}] `)} + "verdict=" + (__pass ? "pass" : "fail") + " score=" + __result.score.toFixed(2) + ${escapeJsonString(` threshold=${gate.threshold}\n`)});`,
    ].join("\n");
  const throwBlock = (title: string, detailOpen: string, indent: string): string =>
    [
      `${indent}const __report = {`,
      `${indent}  class: "evaluation" as const,`,
      `${indent}  title: ${escapeJsonString(title)},`,
      `${indent}  detail: ${escapeJsonString(detailOpen)} + __result.score.toFixed(2) + ${escapeJsonString(` < threshold ${gate.threshold}`)} + (__result.rationale.length > 0 ? " — " + __result.rationale : ""),`,
      `${indent}  remediation: ${escapeJsonString(`raise step "${gated.name}"'s quality (instructions/model), lower the judge threshold, or set on_fail: continue`)},`,
      `${indent}  exitCode: __EVAL_EXIT,`,
      `${indent}};`,
      `${indent}__bus.publish({ ...__bus.envelope(), kind: "run_failed", class: __report.class, message: __report.title + ": " + __report.detail, remediation: __report.remediation, exitCode: __report.exitCode });`,
      `${indent}throw new RunFailedError(__report);`,
    ].join("\n");

  if (gate.onFail === "retry_previous") {
    const nudgeExpr = `${escapeJsonString(`\n\n[judge feedback — the previous attempt failed the "${step.name}" gate (score `)} + __result.score.toFixed(2) + ${escapeJsonString(` < threshold ${gate.threshold})]:\n`)} + __result.rationale`;
    return `${header}  {
    let __retries = 0;
    for (;;) {
${scoringPass("      ")}
      if (__pass) break;
      if (__retries >= ${gate.maxRetries}) {
${throwBlock(
  "judge gate failed after retries",
  `judge step "${step.name}" still scored `,
  "        ",
)}
      }
      __retries += 1;
      process.stdout.write(${escapeJsonString(`[judge ${step.name}] retry `)} + __retries + ${escapeJsonString(`/${gate.maxRetries} of step ${gatedNum}/${total}: ${gated.name}\n`)});
      priorOutput = await __runStep${gatedNum}(${nudgeExpr});
    }
  }
`;
  }
  if (gate.onFail === "halt") {
    return `${header}  {
${scoringPass("    ")}
    if (!__pass) {
${throwBlock("judge gate failed", `judge step "${step.name}" scored `, "      ")}
    }
  }
`;
  }
  // on_fail: continue — record the verdict (event + line) and proceed.
  return `${header}  {
${scoringPass("    ")}
    if (!__pass) {
      process.stdout.write(${escapeJsonString(`[judge ${step.name}] on_fail=continue — proceeding with the flagged output\n`)});
    }
  }
`;
}

/**
 * Build the per-step `tools:` field. Section 11 weaves the discovered
 * Skill tool in alongside any spec-declared built-ins; G05 additionally
 * spreads the wire-once MCP tools (`__mcpTools`) into steps that declare
 * tools. Steps WITHOUT tools stay tool-free — they receive neither the
 * built-ins nor the MCP tools (only the Section 11 skill weave).
 */
function renderStepToolsField(tools: readonly string[], mcpWired: boolean): string {
  const exports = tools
    .map((t) => BUILTIN_TOOL_MAP[t]?.export)
    .filter((e): e is string => typeof e === "string");
  if (exports.length === 0) {
    return "\n    tools: __skillTool ? [__skillTool] : [],";
  }
  const base = mcpWired ? `${exports.join(", ")}, ...__mcpTools` : exports.join(", ");
  return `\n    tools: __skillTool ? [${base}, __skillTool] : [${base}],`;
}

/**
 * Loop contract 0.4 (Batch A) — per-step model-call tuning: `maxTokens`
 * (spec `steps[].max_tokens`) and the extended-thinking selector (spec
 * `steps[].thinking`; the spec's superRefine guarantees exactly one of
 * `{ budgetTokens }` / `{ effort }`). `JSON.stringify` is safe here:
 * numbers plus a closed `low|medium|high` literal union, no free-form
 * user strings. Empty when the step declares neither, keeping
 * pre-existing bundles byte-identical.
 */
function renderStepTuningFields(step: IrWorkflowStep): string {
  const pieces: string[] = [];
  if (step.maxTokens !== undefined) {
    pieces.push(`\n    maxTokens: ${step.maxTokens},`);
  }
  if (step.thinking !== undefined) {
    pieces.push(`\n    thinking: ${JSON.stringify(step.thinking)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the spec-declared `limits` ceilings
 * shared by EVERY step's runChatLoop call. `deadline_ms` bounds the WHOLE
 * workflow run, so it is never passed verbatim (each call would get the
 * full ceiling — N steps would multiply the budget): the runner stamps
 * `__deadlineAt` once at boot and each step's call arms runtime-core's
 * run-deadline timer with the REMAINING budget
 * (`Math.max(1, __deadlineAt - Date.now())`), so the workflow ceiling
 * binds MID-step too — in singleTurn mode the turn is the run, so a fire
 * is the runtime's classified timeout failure. The already-elapsed
 * boundary is handled cleanly BEFORE the call by {@link
 * renderDeadlineGuard} (the `Math.max(1, …)` floor exists so a razor-edge
 * remainder of `<= 0` still arms the timer instead of disarming it).
 * `turn_timeout_ms` passes verbatim — it bounds one step (each step is
 * exactly one singleTurn call). `limits.crew` never appears on this shape
 * (the spec rejects it outside crew). All values are spec-validated
 * numbers / a closed literal union, so `JSON.stringify` is safe. Empty
 * when the spec omits `limits`, keeping pre-existing bundles
 * byte-identical.
 */
function renderLimitsFields(ir: IrWorkflowV0): string {
  const l = ir.limits;
  if (l === undefined) return "";
  const pieces: string[] = [];
  if (l.maxToolIterations !== undefined) {
    pieces.push(`\n    maxToolIterations: ${l.maxToolIterations},`);
  }
  if (l.maxConcurrentTools !== undefined) {
    pieces.push(`\n    maxConcurrentTools: ${l.maxConcurrentTools},`);
  }
  if (l.contextLimit !== undefined) {
    pieces.push(`\n    contextLimit: ${l.contextLimit},`);
  }
  if (l.deadlineMs !== undefined) {
    pieces.push("\n    deadlineMs: Math.max(1, __deadlineAt - Date.now()),");
  }
  if (l.turnTimeoutMs !== undefined) {
    pieces.push(`\n    turnTimeoutMs: ${l.turnTimeoutMs},`);
  }
  if (l.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n    modelCallTimeoutMs: ${l.modelCallTimeoutMs},`);
  }
  if (l.loopDetection !== undefined) {
    pieces.push(`\n    loopDetection: ${JSON.stringify(l.loopDetection)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — `limits.deadline_ms` bounds the WHOLE
 * workflow run (wall clock), not any single step. The generated runner
 * stamps `__deadlineAt` once at the top of main() and guards every step:
 * once the deadline has passed, the run stops with a `[limits]` notice and
 * a non-zero exit code BEFORE opening the next step's turn (mid-step
 * enforcement is the runtime's job — each call arms the run-deadline
 * timer with the remaining budget, see {@link renderLimitsFields}). The
 * guard uses `process.exitCode` + `return` (never `process.exit`) so the
 * MCP `finally` teardown still runs.
 */
function renderDeadlineGuard(
  deadlineMs: number | undefined,
  stepNum: number,
  total: number,
  stepName: string,
): string {
  if (deadlineMs === undefined) return "";
  const notice = `\n[limits] workflow deadline exceeded (deadline_ms = ${deadlineMs}) — stopping before step ${stepNum}/${total}: ${stepName}\n`;
  return [
    "  if (Date.now() >= __deadlineAt) {",
    `    process.stderr.write(${escapeJsonString(notice)});`,
    "    process.exitCode = 1;",
    "    return;",
    "  }",
    "",
  ].join("\n");
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field.
 * The taxonomy is spec-level, so every step's runChatLoop call gets the
 * same classes (mirror: target-cli + target-channel-bot render the same
 * field). Empty when the spec omits the block.
 */
function renderFailureTaxonomyField(ir: IrWorkflowV0): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n    failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Item 27 (Batch A extends the block to this shape) — render the `budget`
 * runChatLoop field, threaded into EVERY step's call. Each step runs its
 * own loop with its own cost meter, so in v0 the cap bounds each step
 * independently (a run-spanning meter needs a runtime-core seam that does
 * not exist yet). `JSON.stringify` safely quotes the degrade `model`
 * string. Empty when the spec omits it. Mirror: target-cli +
 * target-channel-bot + target-managed render the same field.
 */
function renderBudgetField(ir: IrWorkflowV0): string {
  if (ir.budget === undefined) return "";
  return `\n    budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. The IR
 * entries are already HookDef-shaped (hooks-engine's type, camelCase
 * `timeoutMs`), so the bundle declares them as one typed const and layers
 * them BELOW the discovered settings.json hooks: spec entries first, then
 * loadHooks()' user → project entries — aggregateDecisions' later-wins
 * mutate merge keeps the settings layers authoritative, mirroring the
 * permission RuleSet's settings-over-yaml precedence (same ordering as
 * target-cli and the `crewhaus run` interpreter). All hooks still RUN
 * (any deny wins regardless of layer). `JSON.stringify` is safe —
 * `event` is a closed enum and matcher/command land inside JSON-quoted
 * literals. Empty when the spec omits `hooks`.
 */
function renderSpecHooksBoot(ir: IrWorkflowV0): string {
  const specHooks = ir.hooks ?? [];
  if (specHooks.length === 0) return "";
  return [
    "",
    "  // Loop contract 0.4 — spec-declared hooks layer BELOW the discovered",
    "  // settings.json layers (spec first; user → project later-wins).",
    `  const __specHooks: ReadonlyArray<HookDef> = ${JSON.stringify(specHooks)};`,
    "  const __allHooks = [...__specHooks, ...__hooks];",
  ].join("\n");
}

/**
 * G05 — wire-once MCP host for the workflow bundle, following
 * eval-runner's wire-once `McpHost` + `registerMcpServer` pattern: the
 * generated main() boots ONE McpHost, registers every server's tools into
 * ONE private `ToolCatalog` (`__mcpCatalog`), and each step that declares
 * tools spreads the resulting `__mcpTools` into its runChatLoop call.
 * Steps without tools stay tool-free. Teardown is a `finally` around the
 * step sequence so stdio servers are disconnected on success, failure, or
 * a deadline stop.
 *
 * 0.3.0 — env/header values are `IrSecretRef` objects; the UNRESOLVED
 * config is embedded verbatim (no secret value ever lands in the artifact)
 * and `resolveMcpServerConfig` materialises it from the running process's
 * environment at boot, failing fast with the variable's name when a
 * referenced env var is unset (mirror: target-cli renders the same call).
 *
 * When servers are declared but NO step declares tools there is nothing to
 * expose them to, so the bundle skips the boot entirely and surfaces a
 * generated note instead (0.2.3 convention: users notice rather than
 * wondering why their MCP tools never showed up).
 */
function renderMcpServers(ir: IrWorkflowV0): {
  imports: string[];
  bootBlock: string;
  note: string;
  wired: boolean;
} {
  const entries = Object.entries(ir.mcp_servers);
  if (entries.length === 0) {
    return { imports: [], bootBlock: "", note: "", wired: false };
  }
  const anyStepHasTools = ir.steps.some((s) => s.tools.length > 0);
  if (!anyStepHasTools) {
    return {
      imports: [],
      bootBlock: "",
      note: "// note: mcp_servers configured but no step declares tools — servers are not booted (declare tools on a step to expose MCP tools to it)\n",
      wired: false,
    };
  }
  const imports = [
    `import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";`,
    `import { ToolCatalog } from "@crewhaus/tool-catalog";`,
    `import { registerMcpServer } from "@crewhaus/tool-mcp";`,
  ];
  const addLines = entries
    .map(
      ([name, cfg]) =>
        `  __mcpHost.addServer(${escapeJsonString(name)}, resolveMcpServerConfig(${JSON.stringify(cfg)}, { name: ${escapeJsonString(name)} }));`,
    )
    .join("\n");
  const registerLines = entries
    .map(
      ([name]) =>
        `    registerMcpServer(__mcpHost, ${escapeJsonString(name)}, __mcpCatalog, { onRegister: ({ fullName }) => process.stdout.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  const bootBlock = [
    "",
    "  // G05 — wire-once MCP host shared across steps (eval-runner pattern):",
    "  // servers boot once, their tools land in one catalog, and steps that",
    "  // declare tools receive them alongside their built-ins.",
    "  const __mcpHost = new McpHost();",
    addLines,
    "  const __mcpCatalog = new ToolCatalog();",
    "  await Promise.all([",
    registerLines,
    "  ]);",
    "  const __mcpTools = __mcpCatalog.list();",
  ].join("\n");
  return { imports, bootBlock, note: "", wired: true };
}

function renderPermissionsFields(ir: IrWorkflowV0): string {
  const { mode, rules } = ir.permissions;
  if (mode === undefined && rules.length === 0) return "";
  const lines: string[] = [];
  if (mode !== undefined) {
    lines.push(`    permissionMode: ${escapeJsonString(mode)},`);
  }
  if (rules.length > 0) {
    const ruleLits = rules
      .map(
        (r) =>
          `        { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
      )
      .join("\n");
    lines.push(
      [
        "    permissionRules: {",
        "      flag: [],",
        "      settings: [],",
        "      yaml: [",
        ruleLits,
        "      ],",
        "      hooks: [],",
        "      builtin: BUILTIN_DEFAULT_RULES,",
        "    },",
      ].join("\n"),
    );
  }
  return `\n${lines.join("\n")}`;
}

/** Indent every non-empty line by one extra level (the MCP try wrapper). */
function indentStepBodies(stepBodies: string): string {
  return stepBodies
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
}

/**
 * Loop contract 0.4 (Batch B, G02) — module-scope judge machinery, emitted
 * once when the workflow carries judge steps: the `__judgeGate` scorer
 * (eval-judge's forced-tool `judge()` over a synthesized single-criterion
 * rubric with generic 1–5 anchors, mapped to [0,1] via `(n − 1) / 4` — the
 * createJudgeGrader convention) and the classified exit code. The exit
 * code reads `EXIT_CODES.evaluation` with a literal 35 fallback (the next
 * slot in the 3x own-ceiling band after crewhaus_budget 33 / timeout 34)
 * so bundles emitted before @crewhaus/errors ships the member still exit
 * classified. Mirror: target-graph emits the same helper.
 */
const JUDGE_GATE_HELPER = `
/**
 * Loop contract 0.4 (G02) — score \`output\` in [0,1] against free-text
 * judge criteria: eval-judge's forced-tool scorer over a single-criterion
 * rubric (generic 1–5 anchors), mapped down via (n - 1) / 4. The judge
 * model resolves through the model-router, so any provider can judge.
 */
async function __judgeGate(opts: {
  criteria: string;
  model: string;
  gatedTask: string;
  output: string;
}): Promise<{ score: number; rationale: string }> {
  const result = await judge({
    rubric: {
      criteria: [
        {
          name: "criteria",
          description: opts.criteria,
          anchors: {
            "1": "clearly fails the criteria",
            "2": "mostly fails the criteria",
            "3": "partially meets the criteria",
            "4": "mostly meets the criteria",
            "5": "fully meets the criteria",
          },
        },
      ],
      passing_score: 3,
    },
    sample: { id: "judge-gate", input: opts.gatedTask },
    agentOutput: opts.output,
    model: opts.model,
  });
  return { score: (result.score - 1) / 4, rationale: result.rationale };
}
`;

/**
 * G02 — companion const to {@link JUDGE_GATE_HELPER}, emitted only when a
 * gate can THROW (`on_fail: halt` / exhausted `retry_previous`) so
 * continue-only bundles carry no dead throw machinery.
 */
const EVAL_EXIT_CONST = `
// Classified exit for a failed judge gate (falls back to 35 until
// @crewhaus/errors ships EXIT_CODES.evaluation).
const __EVAL_EXIT: number = (EXIT_CODES as Record<string, number>)["evaluation"] ?? 35;
`;

function renderAgent(ir: IrWorkflowV0): string {
  const importLines = resolveAllTools(ir.steps);
  const importBlock = importLines.length > 0 ? `${importLines.join("\n")}\n` : "";
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permFields = renderPermissionsFields(ir);
  const failureTaxonomyField = renderFailureTaxonomyField(ir);
  const limitsFields = renderLimitsFields(ir);
  const budgetField = renderBudgetField(ir);
  // G05 — mcp_servers are WIRED now (wire-once host + per-step tool spread);
  // the pre-0.4 ignored-note remains only for the declared-but-unconsumable
  // corner (no step declares tools).
  const mcp = renderMcpServers(ir);
  const specHooksBoot = renderSpecHooksBoot(ir);
  const hasSpecHooks = specHooksBoot !== "";
  const deadlineMs = ir.limits?.deadlineMs;
  // G02 — judge gates: which steps are judges, and which steps a judge
  // gates (those render as re-invocable closures). `hasThrowingJudges`
  // gates the classified-throw machinery (halt / exhausted retries);
  // continue-only bundles skip it entirely.
  const hasJudges = ir.steps.some(isJudgeStep);
  const hasThrowingJudges = ir.steps.some(
    (s) => isJudgeStep(s) && s.judge !== undefined && s.judge.onFail !== "continue",
  );
  const gatedIdx = new Set<number>();
  for (let i = 0; i < ir.steps.length; i += 1) {
    const s = ir.steps[i];
    if (s !== undefined && isJudgeStep(s)) gatedIdx.add(gatedStepIndex(ir.steps, i));
  }
  const shared: StepShared = {
    permFields,
    failureTaxonomyField,
    limitsFields,
    budgetField,
    hooksExpr: hasSpecHooks ? "__allHooks" : "__hooks",
    deadlineMs,
    mcpWired: mcp.wired,
    runContextLine: hasJudges ? "\n    runContext: __runContext," : "",
  };
  const stepBodies = ir.steps
    .map((s, i) =>
      isJudgeStep(s)
        ? renderJudgeStep(s, i, ir.steps, ir.steps.length, shared)
        : gatedIdx.has(i)
          ? renderGatedStep(s, i, ir.steps.length, shared)
          : renderStep(s, i, ir.steps.length, shared),
    )
    .join("");
  // v0.3.0 — continuity is spec-carried on this shape but not emit-wired in
  // 0.3.0 (only the five agent-loop shapes are). Surface it, 0.2.3-style.
  const continuityWarning =
    ir.continuity !== undefined
      ? "// note: continuity configured but ignored on workflow in 0.3.0\n"
      : "";

  // Section 11 — share hooks/skills/slash-commands across all steps. The
  // discovery happens once at the top of `main` and each step's
  // runChatLoop call reuses the same arrays/maps. Skill tool is appended
  // to a step's local tool list when skills are present. Loop contract 0.4
  // additionally imports hooks-engine's HookDef type when the spec
  // declares its own hooks (the typed `__specHooks` const).
  const extensionImports = `import { ${hasSpecHooks ? "type HookDef, " : ""}loadHooks } from "@crewhaus/hooks-engine";
import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
`;
  const mcpImportBlock = mcp.imports.length > 0 ? `${mcp.imports.join("\n")}\n` : "";

  // limits.deadline_ms — stamped at the very TOP of main(), before the
  // extension discovery and the MCP boot, so the ceiling covers the whole
  // run (boot time included); every step body opens with the guard (see
  // renderDeadlineGuard).
  const deadlineBoot =
    deadlineMs !== undefined
      ? [
          "",
          "  // limits.deadline_ms — wall-clock ceiling for the WHOLE workflow run",
          "  // (boot included), guarded before every step (turn_timeout_ms bounds",
          "  // one step's turn from inside runChatLoop).",
          `  const __deadlineAt = Date.now() + ${deadlineMs};`,
        ].join("\n")
      : "";

  // G05 — with MCP wired, the step sequence runs inside try/finally so the
  // stdio servers disconnect on success, failure, or a deadline stop.
  const stepsSection = mcp.wired
    ? `  try {${indentStepBodies(stepBodies)}  } finally {
    await __mcpHost.disconnectAll();
  }
`
    : stepBodies;

  // G02 — judge-step machinery, emitted only when a judge is present so
  // judge-free bundles stay byte-identical: the eval-judge/errors/
  // run-context imports, the module-scope __judgeGate helper, the shared
  // RunContext boot (one bus for step traces AND judge verdicts), and the
  // classified catch wrapper around main() (target-graph's convention) so
  // a judge halt exits with the report's code instead of a raw Bun stack.
  const errorsMembers = hasThrowingJudges
    ? "EXIT_CODES, RunFailedError, formatRunFailure, toFailureReport"
    : "formatRunFailure, toFailureReport";
  const judgeImports = hasJudges
    ? `import { ${errorsMembers} } from "@crewhaus/errors";
import { judge } from "@crewhaus/eval-judge";
import { createRunContext } from "@crewhaus/run-context";
`
    : "";
  const judgeHelperBlock = hasJudges
    ? `${JUDGE_GATE_HELPER}${hasThrowingJudges ? EVAL_EXIT_CONST : ""}`
    : "";
  const runContextBoot = hasJudges
    ? [
        "",
        "  // G02 — one shared RunContext: every step's trace events and the",
        "  // judge verdicts land on a single bus (single runId, like the graph",
        "  // bundle's shared context).",
        "  const __runContext = createRunContext();",
      ].join("\n")
    : "";
  const mainInvocation = hasJudges
    ? `try {
  await main();
} catch (__err) {
  // G02 — render the ONE structured failure report (a failed judge gate
  // throws a classified RunFailedError) and exit with its coded status
  // instead of an unhandled Bun stack (mirror: target-graph's wrapper).
  const __report = toFailureReport(__err);
  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[workflow]" })}\\n\`);
  process.exit(__report.exitCode);
}`
    : "await main();";

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: workflow, ir version: ${ir.version}, ${ir.steps.length} step(s))
${mcp.note}${continuityWarning}import { runChatLoop } from "@crewhaus/runtime-core";
${judgeImports}${permImport}${extensionImports}${importBlock}${mcpImportBlock}
async function readStdinToEnd(): Promise<string> {
  // No piped input — don't block waiting on an interactive TTY.
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}
${judgeHelperBlock}
async function main(): Promise<void> {
  let priorOutput = "";${deadlineBoot}${runContextBoot}
  const __cwd = process.cwd();
  const [__hooks, __skills, __slashCommands] = await Promise.all([
    loadHooks({ cwd: __cwd }),
    discoverSkills({ cwd: __cwd }),
    loadCommands({ cwd: __cwd }),
  ]);
  const __skillTool = __skills.length > 0 ? createSkillTool(__skills) : null;
  void __skillTool;${specHooksBoot}${mcp.bootBlock}
${stepsSection}}

${mainInvocation}
`;
}
