import { CrewhausError } from "@crewhaus/errors";
import {
  renderControlDrain,
  renderControlImports,
  renderControlLane,
  renderControlPlaneBoot,
  renderControlStart,
  renderControlTimer,
} from "@crewhaus/gateway-protocol/control-codegen";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrKnowledge,
  type IrManagedV0,
  renderBundleReadme,
} from "@crewhaus/ir";
import { memoryFragmentFromIr } from "@crewhaus/memory-service";

/**
 * Emit a managed-daemon bundle. Generates `daemon.ts` that wires:
 *   - `@crewhaus/gateway-server` listening on `process.env.PORT`
 *     (default 3000) with the JWT secret from
 *     `process.env.CREWHAUS_GATEWAY_JWT_SECRET`,
 *   - per-tenant routing via `@crewhaus/tenancy`,
 *   - per-tenant audit log via `@crewhaus/audit-log`,
 *   - the runChatLoop dispatcher inside `runs.create` / `runs.continue`,
 *   - a pluggable `@crewhaus/durable-state` BudgetStore
 *     (`CREWHAUS_BUDGET_STORE=sqlite:<path>` for restart-safe accounting)
 *     shared with the boot-time self-heal janitor (ops item 36), which
 *     clears crash-leaked reservations ONCE at boot (single-writer only —
 *     `CREWHAUS_JANITOR_CLEAR_RESERVATIONS=0` opts out for multi-writer
 *     deployments), evicts expired sessions under the harness's
 *     `.crewhaus/retention.json` policy (pins + sessions.maxAgeDays, the
 *     same contract `crewhaus retention` enforces) across ALL tenant roots
 *     (spec-declared and fallback), and reports orphaned tool_use entries —
 *     boot run + hourly re-run (`CREWHAUS_JANITOR=0` /
 *     `CREWHAUS_JANITOR_INTERVAL_MS` to tune).
 *
 * The agent.ts emitted alongside is shape-compatible with the cli
 * target so existing tools, hooks, skills, and slash commands surface
 * inside the managed daemon without rewrite.
 *
 * Layer F2. Pairs with `gateway-server`, `tenancy`, `audit-log`,
 * `policy-engine`.
 */
export function emitManaged(ir: IrManagedV0, opts: EmitReadmeOptions = {}): Bundle {
  const files = [
    { path: "agent.ts", content: renderAgent(ir) },
    { path: "daemon.ts", content: renderDaemon(ir) },
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
 * Loop contract 0.4 (Batch F, G81) — built-in tool name → package + export.
 * The managed daemon runs on node, so it carries the FULL builtin surface
 * (mirror of `BUILTIN_TOOL_MAP` in target-cli + apps/cli's `loadToolMap()` —
 * keep the three in sync). `initSymbol` names the per-tool config registrar
 * emitted (with the matching `tool_config[name]` blob) before the tool is
 * registered on defaultCatalog.
 */
type BuiltinToolEntry = {
  readonly package: string;
  readonly export: string;
  readonly initSymbol?: string;
};

const BUILTIN_TOOL_MAP: Record<string, BuiltinToolEntry> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  bashOutput: { package: "@crewhaus/tool-bash", export: "bashOutput" },
  killShell: { package: "@crewhaus/tool-bash", export: "killShell" },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite" },
  webFetch: {
    package: "@crewhaus/tool-web",
    export: "webFetch",
    initSymbol: "registerWebFetchConfig",
  },
  webSearch: { package: "@crewhaus/tool-web", export: "webSearch" },
  readImage: { package: "@crewhaus/tool-image", export: "readImage" },
  fetch: {
    package: "@crewhaus/tool-fetch",
    export: "fetch",
    initSymbol: "registerFetchConfig",
  },
  python: {
    package: "@crewhaus/tool-code-execution",
    export: "python",
    initSymbol: "registerCodeExecutionConfig",
  },
  javascript: {
    package: "@crewhaus/tool-code-execution",
    export: "javascript",
    initSymbol: "registerCodeExecutionConfig",
  },
  shell: {
    package: "@crewhaus/tool-code-execution",
    export: "shell",
    initSymbol: "registerCodeExecutionConfig",
  },
  imageGenerate: {
    package: "@crewhaus/tool-image-generation",
    export: "imageGenerate",
    initSymbol: "registerImageGenerationConfig",
  },
  ingestDocument: {
    package: "@crewhaus/tool-document-ingest",
    export: "ingestDocument",
  },
  codegraphSearch: { package: "@crewhaus/tool-codegraph", export: "codegraphSearch" },
  codegraphCallers: { package: "@crewhaus/tool-codegraph", export: "codegraphCallers" },
  codegraphCallees: { package: "@crewhaus/tool-codegraph", export: "codegraphCallees" },
  codegraphImpact: { package: "@crewhaus/tool-codegraph", export: "codegraphImpact" },
};

/**
 * Loop contract 0.4 (Batch F, G81) — resolve the managed spec's `agent.tools`
 * into grouped imports + per-tool config inits + defaultCatalog registrations.
 * Mirror of target-cli's `resolveTools`: a shared `initSymbol` (python/
 * javascript/shell → `registerCodeExecutionConfig`) is emitted exactly once,
 * honoring `tool_config[name]` (or the `codeExecution`/`code_execution`
 * aliases). The `@crewhaus/tool-catalog` import is supplied by the caller's
 * `catalogImport` (defaultCatalog is shared with thredz/knowledge), so it is
 * NOT prepended here. Empty when the spec declares no tools, keeping bundles
 * byte-identical. Per-tenant `tool_config` overlays are a runtime policy-engine
 * concern (the daemon evaluates policy per request with the tenant id); this
 * emit registers the base catalog every tenant draws from.
 */
function resolveManagedTools(
  toolNames: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): { imports: string[]; inits: string[]; registrations: string[] } {
  if (toolNames.length === 0) return { imports: [], inits: [], registrations: [] };
  const byPackage = new Map<string, Set<string>>();
  const registrations: string[] = [];
  const inits: string[] = [];
  const initEmitted = new Set<string>();
  for (const name of toolNames) {
    const entry = BUILTIN_TOOL_MAP[name];
    if (!entry) {
      const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
      throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
    }
    const set = byPackage.get(entry.package) ?? new Set<string>();
    set.add(entry.export);
    byPackage.set(entry.package, set);
    if (entry.initSymbol !== undefined) {
      const cfg =
        toolConfigs[name] ?? toolConfigs["codeExecution"] ?? toolConfigs["code_execution"];
      if (cfg !== undefined && !initEmitted.has(entry.initSymbol)) {
        set.add(entry.initSymbol);
        inits.push(`${entry.initSymbol}(${JSON.stringify(cfg)});`);
        initEmitted.add(entry.initSymbol);
      } else if (cfg !== undefined) {
        set.add(entry.initSymbol);
      }
    }
    registrations.push(`defaultCatalog.register(${entry.export});`);
  }
  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const symbols = [...(byPackage.get(pkg) ?? new Set<string>())].sort();
    imports.push(`import { ${symbols.join(", ")} } from "${pkg}";`);
  }
  return { imports, inits, registrations };
}

/**
 * Item 22 — render the failover-chain runChatLoop fields from the IR agent
 * block, indented for the generated `runOneTurn` body. Empty when the spec
 * declared neither field so existing bundles stay byte-identical. Mirror:
 * target-cli + target-channel-bot render the same fields — keep the three
 * in sync.
 */
function renderModelFailoverFields(ir: IrManagedV0): string {
  const pieces: string[] = [];
  const fallbacks = ir.agent.modelFallbacks;
  if (fallbacks !== undefined && fallbacks.length > 0) {
    pieces.push(`\n    modelFallbacks: [${fallbacks.map((m) => escapeJsonString(m)).join(", ")}],`);
  }
  if (ir.agent.circuitBreaker !== undefined) {
    pieces.push(`\n    circuitBreaker: ${JSON.stringify(ir.agent.circuitBreaker)},`);
  }
  // Item 26 — two-tier router (mirror of target-cli). Absent when unset.
  if (ir.agent.modelTiers !== undefined) {
    pieces.push(`\n    modelTiers: ${JSON.stringify(ir.agent.modelTiers)},`);
  }
  // Adaptive model routing — the N-candidate pool (mirror of target-cli).
  if (ir.agent.modelPool !== undefined) {
    pieces.push(`\n    modelPool: ${JSON.stringify(ir.agent.modelPool)},`);
  }
  return pieces.join("");
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field,
 * indented for the generated `runOneTurn` body. Empty when the spec omits
 * the block. Mirror: target-cli + target-channel-bot render the same field.
 */
function renderFailureTaxonomyField(ir: IrManagedV0): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n    failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Item 27 — render the `budget` runChatLoop field, indented for the
 * generated `runOneTurn` body. Empty when the spec omits it. Mirror:
 * target-cli + target-channel-bot render the same field. This is the
 * RUN-level spend cap; the per-tenant token budgets in daemon.ts
 * (TENANT_OVERRIDES → gateway budget enforcement) are a separate ceiling
 * and continue to override at admission regardless of this field.
 */
function renderBudgetField(ir: IrManagedV0): string {
  if (ir.budget === undefined) return "";
  return `\n    budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Loop contract 0.4 (Batch A) — render the agent-block loop knobs
 * (`maxTokens`, `thinking`, `rateLimits`) as runChatLoop fields, indented
 * for the generated `runOneTurn` body. Empty when the spec declares none of
 * them so existing bundles stay byte-identical. `thinking` is the IrThinking
 * union verbatim ({ budgetTokens } → `ProviderRequest.thinking`; { effort }
 * → `ProviderRequest.reasoningEffort` via the adapter's
 * EFFORT_THINKING_BUDGET_TOKENS table); `rateLimits` is the per-tool
 * `{ rpm, burst? }` record keyed by tool name or `"*"`. Mirror: target-cli +
 * target-channel-bot render the same fields — keep the three in sync.
 */
function renderAgentLoopFields(ir: IrManagedV0): string {
  const pieces: string[] = [];
  if (ir.agent.maxTokens !== undefined) {
    pieces.push(`\n    maxTokens: ${ir.agent.maxTokens},`);
  }
  if (ir.agent.thinking !== undefined) {
    pieces.push(`\n    thinking: ${JSON.stringify(ir.agent.thinking)},`);
  }
  if (ir.agent.rateLimits !== undefined) {
    pieces.push(`\n    rateLimits: ${JSON.stringify(ir.agent.rateLimits)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the top-level `limits:` ceilings as
 * FLAT runChatLoop fields (matching runtime-core's existing flat
 * `maxToolIterations`/`maxConcurrentTools`/`contextLimit` options), indented
 * for the generated `runOneTurn` body. Each knob is emitted only when the
 * spec declared it — the runtime owns per-knob defaults, so an absent knob
 * must stay absent rather than pin today's default into the bundle.
 * `limits.crew` never appears on this shape (spec rejects it outside crew).
 * Mirror: target-cli + target-channel-bot render the same fields.
 */
function renderLimitsFields(ir: IrManagedV0): string {
  const limits = ir.limits;
  if (limits === undefined) return "";
  const pieces: string[] = [];
  if (limits.maxToolIterations !== undefined) {
    pieces.push(`\n    maxToolIterations: ${limits.maxToolIterations},`);
  }
  if (limits.maxConcurrentTools !== undefined) {
    pieces.push(`\n    maxConcurrentTools: ${limits.maxConcurrentTools},`);
  }
  if (limits.contextLimit !== undefined) {
    pieces.push(`\n    contextLimit: ${limits.contextLimit},`);
  }
  if (limits.deadlineMs !== undefined) {
    pieces.push(`\n    deadlineMs: ${limits.deadlineMs},`);
  }
  if (limits.turnTimeoutMs !== undefined) {
    pieces.push(`\n    turnTimeoutMs: ${limits.turnTimeoutMs},`);
  }
  if (limits.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n    modelCallTimeoutMs: ${limits.modelCallTimeoutMs},`);
  }
  if (limits.loopDetection !== undefined) {
    pieces.push(`\n    loopDetection: ${JSON.stringify(limits.loopDetection)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the spec-declared `hooks:` entries as
 * the `hooks` runChatLoop field, indented for the generated `runOneTurn`
 * body. IrHook is shape-identical to hooks-engine's HookDef, so the JSON
 * literal is a valid `HookDef[]` in the generated bundle (declaration order
 * preserved — hook firing order is semantics). The managed shape discovers
 * no settings.json hooks (unlike cli), so the spec list is the whole array.
 * Empty/absent → no field. Mirror: target-cli + target-channel-bot.
 */
function renderHooksField(ir: IrManagedV0): string {
  if (ir.hooks === undefined || ir.hooks.length === 0) return "";
  return `\n    hooks: ${JSON.stringify(ir.hooks)},`;
}

/**
 * Ops item 37 — render the `sloTargets` runChatLoop field from
 * `observability.slo`, indented for the generated `runOneTurn` body. The IR is a
 * numbers + literal-union object (safe to JSON.stringify). Emitting it attaches
 * the SLO monitor per turn (gated by CREWHAUS_SLO) so a deployed managed bundle
 * gets SLO SENSING + the `alert` rung. The daemon separately consults the
 * durable intake gate at admission (F3). The registry-backed pause/rollback
 * mitigation ladder is driven by the CLI `run`/monitor context (which has the
 * spec-registry + deployment-controller); a per-turn managed agent degrades to
 * sensing+alert. Empty when the spec omits the block.
 */
function renderSloField(ir: IrManagedV0): string {
  const slo = ir.observability?.slo;
  if (slo === undefined) return "";
  return `\n    sloTargets: ${JSON.stringify(slo)},`;
}

/**
 * Loop contract 0.4 (Batch C, G26) — thread the `observability` block into the
 * managed daemon by stamping the env vars runtime-core's subscribers read, so a
 * deployed bundle's observability matches its spec out of the box. Each var is
 * set with `??=` (set-if-unset) so an operator's explicit environment ALWAYS
 * wins; the spec supplies the DEFAULT.
 *
 * Applies the keystone's defaults semantics verbatim — spec ABSENCE is NOT
 * "off":
 *   - `cost`  → cost-tracker ON  (`?.cost?.enabled ?? true`) → CREWHAUS_COST_TRACKING
 *   - `trace` → ring (buffer only) by default; `pretty`/`json` attach the
 *      structured printer (CREWHAUS_TRACE). `ring`/`off` attach no printer —
 *      the in-process ring buffer is ALWAYS retained (runs.subscribe replays
 *      it), so `off` degrades to "no printer" here (a true buffer-off would
 *      need a runtime seam and would break SSE replay).
 *   - `metrics`/`alerts`/`incidents` → opt-in OFF (`?.enabled ?? false`) →
 *      CREWHAUS_METRICS=stdout / CREWHAUS_ALERTS=1 / CREWHAUS_INCIDENTS=1
 *   - `otel.endpoint` → OTEL_EXPORTER_OTLP_ENDPOINT (a leading `$VAR` resolves
 *      from the daemon's own env at boot).
 *   - `slo` present → CREWHAUS_SLO=1 (activates the monitor whose targets ride
 *      agent.ts's `sloTargets`).
 *
 * Threading is GATED on the spec actually declaring an `observability` block:
 * a spec that says nothing about observability is left byte/behavior-stable
 * (no forced fleet-wide cost tracking). Once a deployer writes ANY
 * `observability:` block, the keystone defaults apply within it — notably cost
 * defaults ON (`?.cost?.enabled ?? true`). Emits nothing when the block is
 * absent.
 */
function renderObservabilityEnv(ir: IrManagedV0): string {
  const obs = ir.observability;
  if (obs === undefined) return "";
  const lines: string[] = [];
  // cost → ON unless the spec explicitly disables it.
  if ((obs.cost?.enabled ?? true) === true) {
    lines.push(`process.env["CREWHAUS_COST_TRACKING"] ??= "1";`);
  }
  // trace → printer only for pretty/json (ring/off keep the buffer, no printer).
  const traceLevel = obs.trace?.level ?? "ring";
  if (traceLevel === "pretty" || traceLevel === "json") {
    lines.push(`process.env["CREWHAUS_TRACE"] ??= ${escapeJsonString(traceLevel)};`);
  }
  // metrics/alerts/incidents → opt-in.
  if (obs.metrics?.enabled === true) {
    lines.push(`process.env["CREWHAUS_METRICS"] ??= "stdout";`);
  }
  if (obs.alerts?.enabled === true) {
    lines.push(`process.env["CREWHAUS_ALERTS"] ??= "1";`);
  }
  if (obs.incidents?.enabled === true) {
    lines.push(`process.env["CREWHAUS_INCIDENTS"] ??= "1";`);
  }
  // otel → OTLP endpoint (resolve a `$VAR` reference from the daemon's env).
  const endpoint = obs.otel?.endpoint;
  if (endpoint !== undefined && endpoint !== "") {
    if (endpoint.startsWith("$")) {
      const varName = endpoint.slice(1);
      lines.push(
        `{ const __otel = process.env[${escapeJsonString(varName)}]; if (__otel) process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??= __otel; }`,
      );
    } else {
      lines.push(`process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??= ${escapeJsonString(endpoint)};`);
    }
  }
  // slo → activate the monitor (targets ride agent.ts's sloTargets).
  if (obs.slo !== undefined) {
    lines.push(`process.env["CREWHAUS_SLO"] ??= "1";`);
  }
  if (lines.length === 0) return "";
  return `
// Loop contract 0.4 (Batch C, G26) — apply the spec's \`observability\` block as
// the deployment's observability DEFAULTS. Each var is set only when unset
// (\`??=\`) so an operator's explicit environment always wins. Spec absence is
// NOT "off": cost tracking defaults ON; trace keeps the ring buffer (no printer
// unless pretty/json); metrics/alerts/incidents are opt-in.
${lines.join("\n")}
`;
}

/**
 * Loop contract 0.4 (Batch B, G02) — render the in-loop `evaluation:` wiring.
 * The bundle constructs the evaluate fn from the RESOLVED IR grader at
 * module scope in agent.ts and threads it — together with the resolved gate
 * knobs — into `runOneTurn`'s `runChatLoop` call as the `evaluation` option;
 * the runtime scores each completed assistant turn, compares against
 * `threshold`, applies `onFail` (retry ≤ `maxRetries` with the rationale
 * appended as a system nudge / halt as a classified `evaluation` failure /
 * note as an `eval_graded` trace event only) and emits one `eval_graded`
 * event per grading pass.
 *
 *   - `llm_judge` rides `@crewhaus/eval-judge`'s `judge()` (the offline
 *     eval-judge scoring path: single-criterion rubric from `criteria`, 1–5
 *     score mapped to [0,1] via (n-1)/4, prompt-injection-hardened
 *     sentinels). The judge model resolves through the SAME model-router
 *     adapter wiring the bundle's primary model uses, so judge spend is
 *     metered exactly like every other model call; the model defaults to
 *     the shape's primary model when the spec omitted `grader.model`
 *     (`cheapest` already resolved at lower time). `threshold` was resolved
 *     at lower time (default 0.7) — the `?? 0.7` is a defensive floor for
 *     hand-built IR. A3 — an abstaining judge scores 0 with a `judge
 *     abstained: …` rationale (its nominal best-estimate score is a guess
 *     and must never pass the threshold), so `onFail` applies exactly as
 *     for a failed grade.
 *   - `contains` / `regex` are emitted as pure fns (score 1 on pass, 0 on
 *     fail; no model spend, no import). `lastIndex` is reset per call so a
 *     global/sticky flag can never flip-flop verdicts across turns.
 *
 * The emitted literal is annotated `RunEvaluation` (runtime-core's seam
 * type), so a compiled bundle typechecks against the exact runtime
 * contract: `graderType`/`threshold` are stamped verbatim onto every
 * `eval_graded` event (deterministic graders carry the documented
 * threshold 1 — score is 0|1 and `score >= threshold` is the pass rule).
 * Empty pieces when the spec omits the block, keeping pre-existing bundles
 * byte-identical. Mirror: target-cli + target-channel-bot render the same
 * wiring — keep the three in sync.
 */
function renderEvaluation(ir: IrManagedV0): {
  imports: string[];
  bootBlock: string;
  field: string;
} {
  const ev = ir.evaluation;
  if (ev === undefined) return { imports: [], bootBlock: "", field: "" };
  const field = "\n    evaluation: __evaluation,";
  const typeImport = `import type { RunEvaluation } from "@crewhaus/runtime-core";`;
  const onFail = escapeJsonString(ev.onFail);
  if (ev.grader.type === "llm_judge") {
    const criteria = escapeJsonString(ev.grader.criteria);
    const model = escapeJsonString(ev.grader.model ?? ir.agent.model);
    const bootBlock = `const __evaluation: RunEvaluation = {
  graderType: "llm_judge",
  threshold: ${ev.threshold ?? 0.7},
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) => {
    const __verdict = await judge({
      rubric: {
        criteria: [
          {
            name: "criteria",
            description: ${criteria},
            anchors: {
              "1": "fails the criteria entirely",
              "2": "mostly fails the criteria",
              "3": "partially meets the criteria",
              "4": "meets the criteria with minor gaps",
              "5": "fully meets the criteria",
            },
          },
        ],
        passing_score: 3,
      },
      sample: { id: "in-loop-evaluation", input: "" },
      agentOutput: finalText,
      model: ${model},
    });
    if (__verdict.abstain) {
      return { score: 0, rationale: "judge abstained: " + __verdict.rationale };
    }
    return { score: (__verdict.score - 1) / 4, rationale: __verdict.rationale };
  },
};`;
    return {
      imports: [typeImport, `import { judge } from "@crewhaus/eval-judge";`],
      bootBlock,
      field,
    };
  }
  const value = ev.grader.value;
  const valueLit = escapeJsonString(value);
  if (ev.grader.type === "contains") {
    const bootBlock = `const __evaluation: RunEvaluation = {
  graderType: "contains",
  threshold: 1,
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) =>
    finalText.includes(${valueLit})
      ? { score: 1, rationale: ${escapeJsonString(`output contains "${value}"`)} }
      : { score: 0, rationale: ${escapeJsonString(`output missing "${value}"`)} },
};`;
    return { imports: [typeImport], bootBlock, field };
  }
  const bootBlock = `const __evalRegex = new RegExp(${valueLit});
const __evaluation: RunEvaluation = {
  graderType: "regex",
  threshold: 1,
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) => {
    __evalRegex.lastIndex = 0;
    return __evalRegex.test(finalText)
      ? { score: 1, rationale: ${escapeJsonString(`output matches /${value}/`)} }
      : { score: 0, rationale: ${escapeJsonString(`output does not match /${value}/`)} };
  },
};`;
  return { imports: [typeImport], bootBlock, field };
}

/**
 * v0.3.0 PR 11 — the managed shape's memory-fabric wiring state. `wired`
 * when the IR carries an enabled `memory` block and/or a `continuity` block
 * (DEFAULT-ON in 0.3.0 — only `continuity: false` removes it). Scope is
 * `spec`, tenant-fenced: `runOneTurn` receives the request's Tenant and
 * threads it into `wireMemory`, which re-roots every store under the
 * tenant's directory with the stores' own fail-closed path fencing (§2.7 —
 * commingling tenants' plans/wikis is a data-isolation bug, not a gap).
 */
function memoryFabric(ir: IrManagedV0): { wired: boolean; fragmentJson: string } {
  const memoryOn = ir.memory !== undefined && ir.memory.enabled !== false;
  const continuityOn = ir.continuity !== undefined;
  const wired = memoryOn || continuityOn;
  const fragmentJson = wired
    ? JSON.stringify(
        memoryFragmentFromIr({
          name: ir.name,
          ...(memoryOn ? { memory: ir.memory } : {}),
          ...(continuityOn ? { continuity: ir.continuity } : {}),
          // v0.3.0 Goal 2 (PR 17) — learning rides the fragment: wireMemory
          // renders the learning-loop skill + gates in /study /reflect.
          ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
          // Loop contract 0.4 (Batch E, G23) — thredz rides the fragment so
          // wireMemory flips the wiki backend to the hosted Thredz aliases;
          // the LIVE connection (`__thredz` from the module-level connectThredz
          // boot) is threaded separately as the `thredz` dep below.
          ...(ir.thredz !== undefined ? { thredz: ir.thredz } : {}),
        }),
      )
    : "";
  return { wired, fragmentJson };
}

/**
 * Loop contract 0.4 (Batch E, G22) — the module-level knowledge-RAG boot for
 * the managed agent.ts. Ingests the declared sources through
 * `@crewhaus/tool-retrieve`'s `knowledgeRetrieve` ONCE at module load and
 * registers the returned `Retrieve` tool on defaultCatalog; the per-turn tool
 * set unions `defaultCatalog.list()`. The G76 embedder order is deferred to
 * `resolveKnowledgeEmbedder`. Mirror of target-cli's renderKnowledge.
 */
function renderManagedKnowledgeBoot(ir: IrManagedV0): string {
  const k = ir.knowledge as IrKnowledge;
  const memOn = ir.memory !== undefined && ir.memory.enabled !== false;
  const embInputs: string[] = [];
  if (k.embedder !== undefined)
    embInputs.push(`knowledgeEmbedder: ${escapeJsonString(k.embedder)}`);
  const memEmb = memOn ? ir.memory?.embedder : undefined;
  if (memEmb !== undefined) embInputs.push(`memoryEmbedder: ${escapeJsonString(memEmb)}`);
  const wikiEmb = memOn ? ir.memory?.wiki?.embedder : undefined;
  if (wikiEmb !== undefined) embInputs.push(`wikiEmbedder: ${escapeJsonString(wikiEmb)}`);
  const embedderExpr = `resolveKnowledgeEmbedder({ ${embInputs.join(", ")} })`;
  return `
// Loop contract 0.4 (Batch E, G22) — ingest the knowledge corpus ONCE at
// module load and register the Retrieve tool on defaultCatalog.
const __knowledgeTool = await knowledgeRetrieve({
  sources: ${JSON.stringify(k.sources)},
  embedderModel: ${embedderExpr},
  vectorBackend: ${escapeJsonString(k.vectorBackend)},
  defaultK: ${k.defaultK},
  chunkSize: ${k.chunkSize},
  chunkOverlap: ${k.chunkOverlap},
  log: (line) => process.stderr.write(line),
});
defaultCatalog.register(__knowledgeTool);`;
}

/**
 * Permission wiring for the managed agent's `runChatLoop` call.
 *
 * Two things were missing before this existed. First, `ir.permissions` was
 * dropped on the floor — a managed spec that declared `permissions.mode` or
 * `permissions.rules` got a daemon that ignored both (target-cli and
 * target-channel-bot have always wired theirs; mirror them). Second, the
 * daemon is non-interactive: an unmatched tool falls through to `ask` with
 * nobody to prompt. That ask now PARKS as a pending approval (see
 * `renderApprovalFields`), but parking is still an interruption the caller has
 * to resolve out of band. Since this target installs the memory-fabric tools
 * itself — `continuity:` is default-on, so a spec with no `tools:` and no
 * `permissions:` still gets FocusRead/PlanRead/… — it also grants them, at the
 * BUILTIN (lowest-priority) layer so a spec-declared rule still overrides.
 * `__memToolRules` is built next to the `wireMemory` call, so the grant is
 * exactly the tool set that was actually registered for this turn.
 *
 * Returns "" when there is nothing to say (no fabric, no mode, no rules),
 * keeping those bundles byte-identical.
 */
function renderManagedPermissions(ir: IrManagedV0, fabricWired: boolean): string {
  const { mode, rules } = ir.permissions;
  if (!fabricWired && mode === undefined && rules.length === 0) return "";
  const lines: string[] = [];
  if (mode !== undefined) lines.push(`    permissionMode: ${escapeJsonString(mode)},`);
  const yamlRuleLits = rules
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
      yamlRuleLits.length > 0 ? `      yaml: [\n${yamlRuleLits}\n      ],` : "      yaml: [],",
      "      hooks: [],",
      fabricWired
        ? "      builtin: [...BUILTIN_DEFAULT_RULES, ...__memToolRules],"
        : "      builtin: BUILTIN_DEFAULT_RULES,",
      "    },",
    ].join("\n"),
  );
  return `\n${lines.join("\n")}`;
}

/**
 * Loop contract 0.4 (G11) — the `askMode` + `approvals` runChatLoop fields.
 * Unlike the CLI's `approvalRunOptions` a bundle parses no `--ask-mode`, so
 * the spec value is FIXED at emit time.
 *
 * Deliberately SEPARATE from `renderManagedPermissions`, which returns "" for
 * a spec with no `permissions:` block and no fabric — precisely the case where
 * parking matters most, since with no rules every unmatched tool resolves to
 * `ask`. So this is unconditional, and the store is emitted even under
 * `"deny"`, where it never parks: runtime-core picks its diagnostic by testing
 * whether a store was supplied, so withholding it would report absent plumbing
 * for what is a deliberate operator choice. It costs nothing — the store does
 * no I/O until something is actually persisted.
 */
function renderApprovalFields(ir: IrManagedV0, indent: string): string {
  return (
    `\n${indent}askMode: ${escapeJsonString(ir.permissions.askMode ?? "pause")},` +
    `\n${indent}approvals: { store: __approvals, surface: "managed" },`
  );
}

function renderAgent(ir: IrManagedV0): string {
  // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation. Empty
  // pieces when the spec omits the block.
  const evaluation = renderEvaluation(ir);
  const evalImport = evaluation.imports.length > 0 ? `\n${evaluation.imports.join("\n")}` : "";
  const evaluationBlock = evaluation.bootBlock ? `\n\n${evaluation.bootBlock}` : "";
  const fabric = memoryFabric(ir);
  // Loop contract 0.4 (Batch E, G23) — thredz is now emit-WIRED on managed.
  // The managed shape has NO `mcp_servers` field, so this emitter synthesizes
  // the thredz stdio server from `ir.thredz` itself (mirror of the compiler's
  // `synthesizeThredzServer` / cli's `renderMcpServers`) and boots
  // `connectThredz` ONCE at module load. The alias wiki/goals tools land on
  // `defaultCatalog` under BARE names; the live connection threads into every
  // per-turn `wireMemory` call as the backend flip. A boot failure DEGRADES
  // (`__thredz` = null → wireMemory falls back to local files with a warning).
  const thredzOn = ir.thredz !== undefined;
  // Loop contract 0.4 (Batch E) — top-level `memory.embedder`: hybrid recall
  // on the fact store (and the curator's cosine dedupe). Threaded as the
  // structural `deps.embedder`, which beats the fragment's `wiki.embedder`
  // (fallback order `embedder` → `wiki.embedder`). Only meaningful when the
  // fact store wires (an enabled memory block).
  const memEmbedderModel =
    ir.memory !== undefined && ir.memory.enabled !== false ? ir.memory.embedder : undefined;
  const memImports = fabric.wired
    ? `
import { wireMemory } from "@crewhaus/memory-service";
import { createSkillTool } from "@crewhaus/skills-registry";
import type { Tenant } from "@crewhaus/tenancy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";`
    : "";
  // Loop contract 0.4 (Batch E, G22) — agent-shape RAG (`knowledge:`). Like
  // thredz, the managed shape registers the tool on defaultCatalog at module
  // load (top-level await ingest) and unions defaultCatalog.list() into the
  // per-turn tool set. Mirror of target-cli's renderKnowledge (keep in sync).
  const knowledgeOn = ir.knowledge !== undefined;
  // Loop contract 0.4 (Batch F, G81) — spec-declared builtin tools
  // (`agent.tools` + `agent.tool_config`). Registered on defaultCatalog at
  // module load and unioned into the per-turn tool set, exactly like the
  // thredz aliases and the knowledge Retrieve tool. Per-tenant tool_config
  // overlays apply at runtime through the daemon's policy-engine tenant
  // context; this registers the shared base catalog.
  const toolsOn = ir.tools !== undefined && ir.tools.length > 0;
  const resolvedTools = toolsOn
    ? resolveManagedTools(ir.tools ?? [], ir.toolConfigs ?? {})
    : { imports: [], inits: [], registrations: [] };
  const thredzImports = thredzOn
    ? `
import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";
import { connectThredz } from "@crewhaus/memory-service";
import { formatRunFailure, toFailureReport } from "@crewhaus/errors";`
    : "";
  // defaultCatalog is the shared registration surface for thredz aliases, the
  // knowledge Retrieve tool, AND the spec's builtin tools — imported once when
  // any of them is on.
  const catalogImport =
    thredzOn || knowledgeOn || toolsOn
      ? `\nimport { defaultCatalog } from "@crewhaus/tool-catalog";`
      : "";
  const toolImportBlock =
    resolvedTools.imports.length > 0 ? `\n${resolvedTools.imports.join("\n")}` : "";
  // Registered at module load (mirror of target-browser-driver): per-tool
  // config inits run before the register calls so first execution sees them.
  const toolBootBlock =
    resolvedTools.registrations.length > 0
      ? `
// Loop contract 0.4 (Batch F, G81) — register the spec's builtin tools on
// defaultCatalog at module load; the per-turn tool set unions the catalog.
${resolvedTools.inits.length > 0 ? `${resolvedTools.inits.join("\n")}\n` : ""}${resolvedTools.registrations.join("\n")}`
      : "";
  const knowledgeImports = knowledgeOn
    ? `\nimport { knowledgeRetrieve, resolveKnowledgeEmbedder } from "@crewhaus/tool-retrieve";`
    : "";
  const knowledgeBootBlock = knowledgeOn ? renderManagedKnowledgeBoot(ir) : "";
  // Loop contract 0.4 (Batch E, G78) — per-spec cross-run prompt-cache rotation
  // persistence (§2.5). The managed daemon is long-running; one JSON record per
  // spec under .crewhaus/prompt-cache/<spec>.json survives restarts so a
  // still-fresh cache prefix is REUSED instead of cold-started. The stamp is
  // spec-level cache bookkeeping (not tenant data), so one record serves every
  // tenant this daemon fronts.
  const pcImport = `\nimport { createPromptCacheRotationStore } from "@crewhaus/prompt-cache-manager";`;
  const pcBootBlock = `
// Loop contract 0.4 (Batch E, G78) — cross-run prompt-cache rotation store.
const __promptCacheStore = createPromptCacheRotationStore({ specName: ${escapeJsonString(ir.name)} });`;
  const pcFields = `
    promptCacheLastRotatedAt: await __promptCacheStore.read(),
    onPromptCacheRotated: (rotatedAt) => __promptCacheStore.write(rotatedAt),`;
  const embedderImport =
    memEmbedderModel !== undefined ? `\nimport { createEmbedder } from "@crewhaus/embedder";` : "";
  // The synthesized thredz stdio server (mirror of the compiler's
  // `synthesizeThredzServer`): npx runs the version-pinned server; the API key
  // rides the §4.2 secret machinery as an UNRESOLVED IrSecretRef and resolves
  // at boot via `resolveMcpServerConfig` (fail-fast, config exit 21, when
  // unset). Visibility is deterministic (never left to the server default).
  const thredzServerJson = thredzOn
    ? JSON.stringify({
        transport: "stdio",
        command: "npx",
        // NOTE: keep in sync with the compiler's THREDZ_MCP_PACKAGE_SPEC.
        args: ["-y", "thredz-mcp@0.2.0"],
        env: {
          THREDZ_API_KEY: ir.thredz?.apiKey,
          ...(ir.thredz?.baseUrl !== undefined
            ? { THREDZ_API_BASE: { kind: "literal", value: ir.thredz.baseUrl } }
            : {}),
          THREDZ_DEFAULT_VISIBILITY: { kind: "literal", value: ir.thredz?.visibility },
        },
      })
    : "";
  const thredzBootBlock = thredzOn
    ? `
// Loop contract 0.4 (Batch E, G23) — boot the Thredz backend ONCE at module
// load: add the synthesized stdio server, connect + register the wiki/goals
// vocabulary as bare-name aliases on defaultCatalog, and keep the live
// connection for every per-turn wireMemory call (the wiki-backend flip). A
// missing THREDZ_API_KEY is a CONFIG failure (exit 21); a connect failure
// DEGRADES to local files (connectThredz returns null).
const __thredzHost = new McpHost();
try {
  __thredzHost.addServer("thredz", resolveMcpServerConfig(${thredzServerJson}, { name: "thredz" }));
} catch (__err) {
  const __report = toFailureReport(__err);
  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[managed]" })}\\n\`);
  process.exit(__report.exitCode);
}
const __thredz = await connectThredz(__thredzHost, defaultCatalog, { log: (line) => process.stderr.write(line)${
        ir.thredz?.agentName !== undefined
          ? `, agentName: ${escapeJsonString(ir.thredz.agentName)}`
          : ""
      } });`
    : "";
  const embedderBootBlock =
    memEmbedderModel !== undefined
      ? `
// Loop contract 0.4 (Batch E) — top-level \`memory.embedder\`, resolved ONCE at
// module load from the \`@crewhaus/embedder\` factory grammar.
const __memEmbedder = createEmbedder({ model: ${escapeJsonString(memEmbedderModel)} });`
      : "";
  const memEmbedderDep = memEmbedderModel !== undefined ? "\n    embedder: __memEmbedder," : "";
  const thredzDep = thredzOn && fabric.wired ? "\n    thredz: __thredz," : "";
  const tenantArgField = fabric.wired
    ? `
  /** v0.3.0 — the request's tenant; fences every memory-fabric store. */
  readonly tenant: Tenant;`
    : "";
  const memBlock = fabric.wired
    ? `
  // v0.3.0 — the memory fabric, wired per turn through the ONE stable
  // composition-root call (design §1 principle 1), tenant-fenced (§2.7).
  const __memTools: RegisteredTool[] = [];
  const __memWired = await wireMemory(${fabric.fragmentJson}, {
    catalog: { register: (t: RegisteredTool) => { __memTools.push(t); } },
    cwd: process.cwd(),${memEmbedderDep}${thredzDep}
    tenant: args.tenant,
    sessionScope: args.sessionId,
  });
  const __skills = __memWired.options.skills ?? [];
  if (__skills.length > 0) __memTools.push(createSkillTool(__skills));
  // The daemon is a NON-INTERACTIVE surface, so an "ask" decision has nobody
  // to prompt: it parks the turn for out-of-band approval (or, under
  // \`ask_mode: deny\`, denies in place). The fabric above installs these tools
  // WITHOUT the spec asking for them (\`continuity:\` is default-on), so this
  // target grants exactly what it installed — a spec with no \`permissions:\`
  // block must not stall an open-ended prompt on its own bookkeeping tools.
  // These sit at the BUILTIN layer, the lowest-priority source: they are a
  // default, so any spec-declared rule (including an \`alwaysDeny\` on a memory
  // tool) still wins. Nothing else is widened — tools the spec itself declared
  // keep the ordinary ask floor.
  const __memToolRules: PermissionRule[] = __memTools.map((t) => ({
    type: "alwaysAllow",
    pattern: t.name,
    source: "builtin",
  }));
`
    : "";
  // Loop contract 0.4 (Batch E, G22/G23) — both the thredz alias vocabulary
  // (G23 — the thredz-backed wiki path returns no local tools of its own) and
  // the knowledge Retrieve tool (G22) register on defaultCatalog at module
  // load, so whenever either is on the per-turn tool set unions
  // `defaultCatalog.list()` with the per-turn memory tools.
  const catalogUnion = thredzOn || knowledgeOn || toolsOn;
  const toolsExpr = catalogUnion
    ? fabric.wired
      ? "[...__memTools, ...defaultCatalog.list()]"
      : "defaultCatalog.list()"
    : "__memTools";
  const memRunFields = fabric.wired
    ? `
    tools: ${toolsExpr},
    ...__memWired.options,`
    : catalogUnion
      ? `
    tools: ${toolsExpr},`
      : "";
  const permissionsField = renderManagedPermissions(ir, fabric.wired);
  // Loop contract 0.4 (G11) — the pending-approval store, built PER TURN and
  // never at module scope: every turn runs inside the request's `withTenant`,
  // and `resolveSessionRootDir` reads the ACTIVE tenant's rebased root. A
  // module-scope store would resolve once, outside any tenant scope, and pool
  // every tenant's parks — records that echo the raw tool input — into the
  // process-global `.crewhaus/sessions`.
  const approvalsBoot = `  // G11 — a compiled bundle is NON-INTERACTIVE: a tool that lands on \`ask\`
  // has nobody to prompt, so without this it collapsed to a deny. Rooted where
  // this turn's session files land, so parks live beside them, inside the
  // requesting tenant's root. No I/O until a park.
  const __approvalRoot = resolveSessionRootDir(undefined);
  const __approvals = createPendingApprovalStore(
    __approvalRoot !== undefined ? { rootDir: __approvalRoot } : {},
  );

`;
  const permissionImports =
    permissionsField.length > 0
      ? `\nimport { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";${
          fabric.wired ? `\nimport type { PermissionRule } from "@crewhaus/permission-engine";` : ""
        }`
      : "";
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: managed, ir version: ${ir.version})
import { runChatLoop } from "@crewhaus/runtime-core";
import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";
import type { RunChatLoopOptions } from "@crewhaus/runtime-core";${permissionImports}${pcImport}${memImports}${thredzImports}${catalogImport}${toolImportBlock}${knowledgeImports}${embedderImport}${evalImport}${evaluationBlock}${toolBootBlock}${thredzBootBlock}${embedderBootBlock}${knowledgeBootBlock}${pcBootBlock}

export type ManagedAgentArgs = {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly input: string;${tenantArgField}
  readonly extraOptions?: Partial<RunChatLoopOptions>;
};

export async function runOneTurn(args: ManagedAgentArgs): Promise<string> {
${memBlock}${approvalsBoot}  return await runChatLoop({
    model: ${escapeJsonString(ir.agent.model)},
    instructions: ${escapeJsonString(ir.agent.instructions)},${renderAgentLoopFields(ir)}${renderModelFailoverFields(ir)}${renderFailureTaxonomyField(ir)}${renderBudgetField(ir)}${evaluation.field}${renderLimitsFields(ir)}${renderHooksField(ir)}${renderSloField(ir)}
    sessionName: args.sessionId,
    sessionTarget: "managed",
    seedMessages: [{ role: "user", content: args.input }],
    singleTurn: true,${pcFields}${memRunFields}${permissionsField}${renderApprovalFields(ir, "    ")}
    ...(args.extraOptions ?? {}),
  });
}
`;
}

/**
 * Loop contract 0.4 (Batch F, temporal contract / ITEM 7) — lower `ir.schedule`
 * into the managed daemon's wake loop. Each tick runs a synthetic agent turn
 * per DECLARED tenant (deterministic, mirroring the janitor's per-tenant sweep)
 * in a FRESH session — the "wake, decide, act, sleep" pattern; cross-tick memory
 * is a `continuity:` concern, not the scheduler's. A failed tick is classified
 * and logged; the daemon keeps serving. `CREWHAUS_SCHEDULE=0` disarms it.
 *
 * Interval arms a `setInterval(everyMs)`; cron arms a 30s minute-ticker that
 * fires on the first second a minute matches (deduped per minute). The cron
 * matcher supports `*`, `*​/n`, `a-b`, `a,b` and plain fields over 5- or 6-field
 * expressions, evaluated in the daemon's LOCAL clock; a declared `timezone`
 * and the advanced tokens `L`/`W`/`#` are best-effort (unmatched tokens simply
 * do not fire). Returns empty pieces when the spec omits `schedule:`, keeping
 * pre-existing bundles byte-identical.
 */
function renderScheduleWake(ir: IrManagedV0): { helpers: string; block: string; shutdown: string } {
  const schedule = ir.schedule;
  if (schedule === undefined) return { helpers: "", block: "", shutdown: "" };
  const wakeTenant = memoryFabric(ir).wired ? "\n        tenant: __tenant," : "";
  const instructions = escapeJsonString(
    schedule.instructions ?? "Scheduled wake tick — check for due work and act on it.",
  );
  const jitterExpr =
    schedule.jitterMs !== undefined && schedule.jitterMs > 0
      ? `Math.floor(Math.random() * ${schedule.jitterMs})`
      : "0";
  // crewhaus.control.v1 — the wake body is registered as a control LANE, so
  // `POST /control/v1/wake {lane:"schedule"}` drives this exact fan-out and a
  // poke arriving mid-tick is refused with 409 rather than overlapping it.
  // On this MULTI-TENANT shape one tick is one turn PER DECLARED TENANT, each
  // in that tenant's own session root; the id the wake answers with identifies
  // the WAKE itself (the record carrying `{synthetic, reason, by}`), not any
  // single tenant's transcript.
  const fireFn = `
// Loop contract 0.4 (Batch F, temporal contract) — schedule: wake loop.
const __SCHEDULE_INSTRUCTIONS = ${instructions};
let __scheduleTick = 0;
let __scheduleTimer: ReturnType<typeof setInterval> | undefined;
${renderControlLane({
  lane: "schedule",
  varName: "__scheduleLane",
  cadence:
    schedule.kind === "cron"
      ? `cron "${schedule.cron}"${schedule.timezone !== undefined ? ` ${schedule.timezone}` : " local"}`
      : `every ${schedule.everyMs}ms`,
  ...(schedule.kind === "interval" ? { everyMs: schedule.everyMs } : {}),
  body: `const __tickNo = __scheduleTick++;
const __origin = __tick.synthetic !== undefined ? \` (synthetic: \${__tick.synthetic.reason})\` : "";
for (const __tenantId of Object.keys(TENANT_OVERRIDES)) {
  const __tenant = tenantOverrides[__tenantId];
  if (__tenant === undefined) continue;
  const __sessionId = \`sess_\${randomBytes(8).toString("hex")}\`;
  try {
    const __reply = await runOneTurn({
      tenantId: __tenantId,
      sessionId: __sessionId,
      input: __SCHEDULE_INSTRUCTIONS,${wakeTenant.replace("\n        ", "\n      ")}
    });
    __control.counters.turns++;
    const __preview = __reply.length > 200 ? \`\${__reply.slice(0, 200)}…\` : __reply;
    console.error(\`[schedule] tenant \${__tenantId} tick #\${__tickNo}\${__origin} → \${__preview}\`);
  } catch (__err) {
    // A dead provider account / classified failure for one tenant must not
    // stop the scheduler; render its report and keep ticking.
    if (isRunFailedError(__err)) {
      process.stderr.write(\`\${formatRunFailure(__err.report, { prefix: "[schedule]" })}\\n\`);
    } else {
      process.stderr.write(
        \`[schedule] tenant \${__tenantId} tick #\${__tickNo} error: \${(__err as Error).message}\\n\`,
      );
    }
  }
}`,
})}async function __fireScheduledWake(): Promise<void> {
  await __scheduleLane.tick();
}`;

  if (schedule.kind === "interval") {
    const block = `${fireFn}
if (process.env.CREWHAUS_SCHEDULE !== "0") {
  __scheduleTimer = setInterval(async () => {
    const __jitterMs = ${jitterExpr};
    if (__jitterMs > 0) await new Promise((__r) => setTimeout(__r, __jitterMs));
    await __fireScheduledWake();
  }, ${schedule.everyMs});
  console.error(\`[schedule] interval wake armed every ${schedule.everyMs}ms\`);
}
`;
    return {
      helpers: "",
      block,
      shutdown: "\n  if (__scheduleTimer !== undefined) clearInterval(__scheduleTimer);",
    };
  }

  // cron arm
  const helpers = `
// Loop contract 0.4 (Batch F) — minute-granularity cron matcher for the
// schedule: wake loop (supports *, *​/n, a-b, a,b over 5/6-field expressions).
function __cronFieldMatches(field: string, value: number): boolean {
  if (field === "*" || field === "?") return true;
  for (const part of field.split(",")) {
    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      if (Number.isFinite(step) && step > 0 && value % step === 0) return true;
      continue;
    }
    const dash = part.indexOf("-");
    if (dash > 0) {
      const lo = Number(part.slice(0, dash));
      const hi = Number(part.slice(dash + 1));
      if (Number.isFinite(lo) && Number.isFinite(hi) && value >= lo && value <= hi) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
}
function __cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\\s+/);
  // 6-field expressions lead with seconds (ignored at minute granularity).
  const off = fields.length === 6 ? 1 : 0;
  const min = fields[off];
  const hr = fields[off + 1];
  const dom = fields[off + 2];
  const mon = fields[off + 3];
  const dow = fields[off + 4];
  if (min === undefined || hr === undefined || dom === undefined || mon === undefined || dow === undefined) {
    return false;
  }
  return (
    __cronFieldMatches(min, date.getMinutes()) &&
    __cronFieldMatches(hr, date.getHours()) &&
    __cronFieldMatches(dom, date.getDate()) &&
    __cronFieldMatches(mon, date.getMonth() + 1) &&
    __cronFieldMatches(dow, date.getDay())
  );
}`;
  const block = `${fireFn}
if (process.env.CREWHAUS_SCHEDULE !== "0") {
  const __cronExpr = ${escapeJsonString(schedule.cron)};
  let __lastCronMinute = "";
  __scheduleTimer = setInterval(async () => {
    const __now = new Date();
    const __minuteKey = \`\${__now.getFullYear()}-\${__now.getMonth()}-\${__now.getDate()}-\${__now.getHours()}-\${__now.getMinutes()}\`;
    if (__minuteKey === __lastCronMinute) return; // one fire per matching minute
    if (!__cronMatches(__cronExpr, __now)) return;
    __lastCronMinute = __minuteKey;
    const __jitterMs = ${jitterExpr};
    if (__jitterMs > 0) await new Promise((__r) => setTimeout(__r, __jitterMs));
    await __fireScheduledWake();
  }, 30_000);
  console.error(\`[schedule] cron ${escapeJsonString(schedule.cron)} wake armed\`);
}
`;
  return {
    helpers,
    block,
    shutdown: "\n  if (__scheduleTimer !== undefined) clearInterval(__scheduleTimer);",
  };
}

/**
 * Item 2 (G31) — the A2A federation peer surface for the generated daemon.
 * Emits the `federation` config the daemon hands to `createGatewayServer`,
 * env-gated at RUNTIME (unset federation env ⇒ `undefined` ⇒ the well-known +
 * inbound routes answer 404, behaviour-preserving). `tenantFieldFed` threads
 * the memory-fabric tenant into the inbound dispatch's `runOneTurn` exactly as
 * the gateway handler does. The whole block is always emitted so any managed
 * deployment can be turned into a peer purely by setting env — no recompile.
 */
function renderFederation(ir: IrManagedV0): { block: string; field: string } {
  const firstLine = ir.agent.instructions.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const description =
    firstLine.length > 0
      ? firstLine.length > 200
        ? `${firstLine.slice(0, 197)}...`
        : firstLine
      : `${ir.name} — a managed CrewHaus agent.`;
  const tenantFieldFed = memoryFabric(ir).wired ? ", tenant: fedTenant" : "";
  const block = `
// Item 2 (G31) — A2A federation peer surface. This deployment serves
// GET /.well-known/agent-card.json (a real A2A Agent Card), GET
// /.well-known/crewhaus.json (the namespaced discovery alias carrying the
// cert-pin fingerprint) and POST /federation (the inbound handler) WHEN it is
// configured as a peer: set CREWHAUS_FEDERATION_DEPLOYMENT_ID (its id),
// CREWHAUS_FEDERATION_ENDPOINT (public base URL) and
// CREWHAUS_FEDERATION_FINGERPRINT (64-hex sha256 of its leaf cert). Any unset ⇒
// the federation routes answer 404. Inbound calls are gated by
// CREWHAUS_FEDERATION_ALLOWED_PEERS (comma-separated peer deployment ids); an
// empty/unset allowlist DENIES every inbound call — an explicit allowlist is
// required to accept a remote peer. mTLS termination (the transport-level
// authentication floor) is the operator's responsibility (Bun tls / a proxy).
const FED_DEPLOYMENT_ID = process.env.CREWHAUS_FEDERATION_DEPLOYMENT_ID;
const FED_ENDPOINT = process.env.CREWHAUS_FEDERATION_ENDPOINT;
const FED_FINGERPRINT = process.env.CREWHAUS_FEDERATION_FINGERPRINT;
const FED_ALLOWED_PEERS = (process.env.CREWHAUS_FEDERATION_ALLOWED_PEERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const federation: GatewayFederationConfig | undefined =
  FED_DEPLOYMENT_ID && FED_ENDPOINT && FED_FINGERPRINT
    ? {
        identity: {
          name: ${escapeJsonString(ir.name)},
          description: ${escapeJsonString(description)},
          endpoint: FED_ENDPOINT,
          publicKeyFingerprint: FED_FINGERPRINT,
          supportedShapes: ["managed"],
        },
        // App-level peer gate. mTLS authenticated *who*; this decides *whether*
        // the peer is allowlisted. Authentication ≠ authorization.
        authorize: (ctx) => {
          const from = ctx.envelope.federation.from.deployment;
          return FED_ALLOWED_PEERS.includes(from)
            ? { ok: true }
            : { ok: false, reason: \`peer "\${from}" not in CREWHAUS_FEDERATION_ALLOWED_PEERS\` };
        },
        // Dispatch an authorized inbound call onto a local run under the first
        // declared tenant (a real deployment maps peers→tenants). The
        // gateway-server has already validated + classified the payload.
        dispatch: async (ctx) => {
          const fedTenant =
            Object.values(tenantOverrides)[0] ??
            buildTenant(FED_DEPLOYMENT_ID, { tenantsRoot: TENANTS_ROOT });
          const fedRunContext = createRunContext({
            runId: \`fedrun_\${randomBytes(4).toString("hex")}\`,
            sessionId: \`fedsess_\${randomBytes(6).toString("hex")}\`,
          });
          const reply = await withTenant(fedTenant, () =>
            runOneTurn({
              tenantId: fedTenant.id,
              sessionId: fedRunContext.sessionId,
              input: ctx.envelope.payload${tenantFieldFed},
              extraOptions: { runContext: fedRunContext },
            }),
          );
          return { reply };
        },
      }
    : undefined;
`;
  return { block, field: "\n  federation," };
}

function renderDaemon(ir: IrManagedV0): string {
  // v0.3.0 — thread the request's Tenant into runOneTurn so the memory
  // fabric's stores are tenant-fenced (§2.7).
  const tenantField = memoryFabric(ir).wired ? ", tenant" : "";
  // Loop contract 0.4 (Batch F, temporal contract / ITEM 7) — schedule: wake
  // loop pieces (empty when the spec omits `schedule:`).
  const scheduleWake = renderScheduleWake(ir);
  // Item 2 (G31) — the A2A federation peer surface (env-gated at runtime).
  const federationSurface = renderFederation(ir);
  // v0.3.0 PR 14 (§6.3) — the dream consolidation step, registered into the
  // existing boot+hourly janitor tick. Multi-tenant daemons run the
  // DETERMINISTIC phase per tenant (tenantsRootDir mode — re-enumerated
  // each run, exactly like the janitor's own session sweep); the model
  // phase is deliberately never fired from a multi-tenant janitor:
  // per-tenant model spend needs an explicit operator decision (a
  // per-tenant `crewhaus dream run` cron).
  const dreamOn =
    ir.memory !== undefined && ir.memory.enabled !== false && ir.memory.dream !== undefined;
  const dreamImport = dreamOn
    ? `import { createDreamJanitorStep } from "@crewhaus/memory-service";\n`
    : "";
  const dreamStepBlock = dreamOn
    ? `
// v0.3.0 §6.3 — scheduled memory consolidation (dream), deterministic per
// tenant, due-checked against <tenantRoot>/dream/<spec>/state.json each
// tick. CREWHAUS_DREAM=0 disables; CREWHAUS_DREAM_INTERVAL_MS overrides the
// cadence. The model phase is never fired from a multi-tenant janitor —
// per-tenant model spend needs an explicit operator decision: schedule a
// per-tenant \`crewhaus dream run\` cron for full consolidation.
const DREAM_STEP = createDreamJanitorStep(${memoryFabric(ir).fragmentJson}, {
  cwd: process.cwd(),
  tenantsRootDir: TENANTS_ROOT,
});
`
    : "";
  // NEW-inloop-coverage — the gateway's rating-capture surface. Presence of
  // the `feedback:` block (not disabled) opts in to the `feedback.submit`
  // JSON-RPC method; `autoDistill` additionally registers the D39 distill
  // janitor step, because a gateway daemon never runs a `crewhaus run`
  // teardown and its ratings would otherwise accumulate forever.
  const feedbackOn = ir.feedback !== undefined && ir.feedback.enabled !== false;
  const distillOn = feedbackOn && ir.feedback?.autoDistill === true;
  // `randomBytes` is already in the unconditional preamble below, so this
  // adds only what the handler needs on top of it.
  const feedbackImport = feedbackOn
    ? 'import { appendFileSync, existsSync, mkdirSync } from "node:fs";\nimport { buildFeedbackRecord } from "@crewhaus/feedback-distill";\n'
    : "";
  // GatewayServerError rides the existing gateway-server import so the emitted
  // module never names one specifier twice.
  const gatewayServerImport = feedbackOn
    ? 'import { createGatewayServer, GatewayServerError, type GatewayFederationConfig } from "@crewhaus/gateway-server";'
    : 'import { createGatewayServer, type GatewayFederationConfig } from "@crewhaus/gateway-server";';
  const distillImport = distillOn
    ? 'import { createDistillJanitorStep } from "@crewhaus/feedback-distill";\nimport { createFileBackedRegistry } from "@crewhaus/dataset-registry";\n'
    : "";
  const distillCarried: { enabled?: boolean; autoDistill: true } = { autoDistill: true };
  if (ir.feedback?.enabled !== undefined) distillCarried.enabled = ir.feedback.enabled;
  const distillStepBlock = distillOn
    ? `
// D39 / NEW-inloop-coverage — accumulated gateway ratings distill into a new
// version of the \`${ir.name}-ratings\` registry dataset on the janitor's own
// clock. Shares the .crewhaus/feedback/.distill-state.json watermark with the
// CLI consumer, so once cron / \`crewhaus distill\` / this daemon lands a
// batch the others see nothing unprocessed (a shared watermark, not a lock —
// two OVERLAPPING runs can each register a version of the same ratings).
//
// tenantsRootDir is LOAD-BEARING: every turn runs inside withTenant(), so the
// transcripts live under <TENANTS_ROOT>/<tenantId>/sessions and NOT under
// <cwd>/.crewhaus/sessions. Sweeping the wrong root would make every
// submitted rating look unmatchable — and the watermark would then burn it.
// The per-tenant roots are re-enumerated each tick, exactly like the
// janitor's own session sweep and the dream step above. The ratings sink and
// the watermark stay at the harness root (that is where feedback.submit
// writes them). Split rater verdicts (B19) go to .crewhaus/review/queue.jsonl
// — \`crewhaus review next\`. CREWHAUS_AUTODISTILL=0 disables;
// CREWHAUS_AUTODISTILL_THRESHOLD overrides the ">= 5 unprocessed" trigger.
const DISTILL_STEP = createDistillJanitorStep({
  specName: ${escapeJsonString(ir.name)},
  feedback: ${JSON.stringify(distillCarried)},
  registry: createFileBackedRegistry({
    rootDir: process.env.CREWHAUS_DATASETS_DIR ?? \`\${process.cwd()}/.crewhaus/datasets\`,
  }),
  cwd: process.cwd(),
  tenantsRootDir: TENANTS_ROOT,
});
`
    : "";
  // A dream-only daemon keeps its historical single-expression steps field
  // byte for byte; the spread form appears only with a second step.
  const dreamStepsField = !distillOn
    ? dreamOn
      ? "\n  steps: DREAM_STEP !== null ? [DREAM_STEP] : [],"
      : ""
    : `\n  steps: [${[
        ...(dreamOn ? ["...(DREAM_STEP !== null ? [DREAM_STEP] : [])"] : []),
        "...(DISTILL_STEP !== null ? [DISTILL_STEP] : [])",
      ].join(", ")}],`;
  const feedbackHandlerBlock = feedbackOn
    ? `
    if (method === "feedback.submit") {
      // NEW-inloop-coverage — the gateway's rating-capture route. The record
      // is written to the SAME .crewhaus/feedback sink \`crewhaus distill\` /
      // \`optimize --ratings\` / \`judge calibrate\` already read, per tenant
      // and mode 0600. The daemon stamps schemaVersion/id/source/ts itself so
      // a client cannot forge provenance or backdate a rating past the
      // auto-distill watermark.
      const fb = params as {
        sessionId: string;
        turnNumber: number;
        thumbs?: "up" | "down";
        stars?: number;
        scale?: { value: number; min: number; max: number };
        comment?: string;
        correction?: string;
        rater?: string;
        adjudication?: boolean;
      };
      // TENANT FENCE. distill() joins ratings to turns on (sessionId,
      // turnNumber) across the WHOLE .crewhaus/feedback sink, so an
      // unfenced write would let any authenticated tenant attach a rating —
      // or a \`correction\`, which becomes expected_output — to another
      // tenant's turn and poison the shared <spec>-ratings dataset. Every
      // other managed storage path is fenced (session-store / event-log /
      // audit-log assertSamePath); this one is fenced here. The protocol
      // schema pins sessionId to /^sess_[0-9a-f]{16}$/, so the id can never
      // escape the tenant's session root as a path.
      if (!existsSync(\`\${tenant.sessionRoot}/\${fb.sessionId}.jsonl\`)) {
        throw new GatewayServerError(
          \`unknown session "\${fb.sessionId}" for this tenant — feedback.submit only rates your own sessions\`,
        );
      }
      // buildFeedbackRecord is the ONE constructor for a FeedbackRecord: it
      // clips + strips control characters from comment/correction
      // (MAX_FEEDBACK_TEXT), enforces the stars range, and refuses an
      // adjudication with no verdict. The gateway is the least-trusted
      // capture surface in the product, so it must not hand-roll the shape.
      let record: ReturnType<typeof buildFeedbackRecord>;
      try {
        record = buildFeedbackRecord({
          id: \`fb_\${randomBytes(6).toString("hex")}\`,
          sessionId: fb.sessionId,
          turnNumber: fb.turnNumber,
          ...(fb.thumbs !== undefined ? { thumbs: fb.thumbs } : {}),
          ...(fb.stars !== undefined ? { stars: fb.stars } : {}),
          ...(fb.scale !== undefined ? { scale: fb.scale } : {}),
          ...(fb.comment !== undefined ? { comment: fb.comment } : {}),
          ...(fb.correction !== undefined ? { correction: fb.correction } : {}),
          ...(fb.rater !== undefined ? { rater: fb.rater } : {}),
          ...(fb.adjudication === true ? { adjudicate: true } : {}),
          source: "ui",
          ts: new Date().toISOString(),
        });
      } catch (err) {
        throw new GatewayServerError(
          \`invalid feedback: \${err instanceof Error ? err.message : String(err)}\`,
        );
      }
      const feedbackDir = \`\${process.cwd()}/.crewhaus/feedback\`;
      mkdirSync(feedbackDir, { recursive: true });
      appendFileSync(\`\${feedbackDir}/\${tenant.id}.jsonl\`, \`\${JSON.stringify(record)}\n\`, {
        mode: 0o600,
      });
      // gateway-server already appended the \`gateway_request\` entry for THIS
      // call before dispatching us, so a second one would double-count the
      // method and read like a replay on the hash chain. This is a distinct
      // record: the durable write, named by record id.
      const log = await gateway.getAuditLog(tenant);
      await log.append({
        kind: "feedback_recorded",
        payload: {
          tenantId: tenant.id,
          sessionId: fb.sessionId,
          turnNumber: fb.turnNumber,
          modality: record.modality,
          recordId: record.id,
        },
      });
      return { recorded: true, id: record.id };
    }
`
    : "";

  // crewhaus.control.v1 — emitted into every daemon-shape bundle from the
  // shared gateway-protocol renderers. The managed shape keeps its richer
  // crewhaus.v1 JSON-RPC gateway on the public port; control.v1 is the
  // lowest-common-denominator surface every daemon shape shares, on its own
  // loopback-bound port.
  const controlPlaneBoot = renderControlPlaneBoot({
    name: ir.name,
    target: "managed",
    auditLogExpr: "CONTROL_AUDIT",
  });
  const controlJanitorTimer = renderControlTimer({
    expr:
      '{ lane: "janitor", cadence: `every ${JANITOR_INTERVAL_MS}ms`, ' +
      '...(__janitorLastRunAt !== undefined ? { lastFiredAt: __janitorLastRunAt, lastOutcome: "ok" } : {}) }',
  });
  const controlDrain = renderControlDrain({
    body: `console.error("[managed] draining — intake stopped");
janitor.stop();${ir.schedule ? "\nif (__scheduleTimer !== undefined) clearInterval(__scheduleTimer);" : ""}
await janitor.runOnce();
await handle.close();`,
  });
  const controlStart = renderControlStart({});

  const tenantList = ir.tenants
    .map(
      (t) =>
        `  ${escapeJsonString(t.id)}: { id: ${escapeJsonString(
          t.id,
        )}, budget: { maxInputTokens: ${t.budget.maxInputTokens}, maxOutputTokens: ${t.budget.maxOutputTokens} } }`,
    )
    .join(",\n");
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: managed, ir version: ${ir.version})
import { loadRetentionConfig } from "@crewhaus/data-retention-engine";
import { createBudgetStore } from "@crewhaus/durable-state";
import { formatRunFailure, isRunFailedError } from "@crewhaus/errors";
${gatewayServerImport}
import {
  createInMemoryIdempotencyStore,
  idempotencyKey,
  withIdempotency,
} from "@crewhaus/idempotency-keys";
import { openAuditLog } from "@crewhaus/audit-log";
${renderControlImports()}import { auditPolicyDecision, evaluatePolicy } from "@crewhaus/policy-engine";
import { createRunContext, type RunContext } from "@crewhaus/run-context";
${dreamImport}${distillImport}${feedbackImport}import { createJanitor } from "@crewhaus/runtime-core";
import { buildTenant, withTenant, type Tenant } from "@crewhaus/tenancy";
import { runOneTurn } from "./agent.ts";

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
${renderObservabilityEnv(ir)}const TENANTS_ROOT = process.env.CREWHAUS_TENANTS_ROOT ?? "/tmp/crewhaus-tenants";
const PORT = Number(process.env.PORT ?? 3000);
const ENV_JWT_SECRET = process.env.CREWHAUS_GATEWAY_JWT_SECRET;
if (ENV_JWT_SECRET !== undefined && ENV_JWT_SECRET.length < 16) {
  console.error(
    "[managed] CREWHAUS_GATEWAY_JWT_SECRET is set but too short (min 16 chars). Refusing to start.",
  );
  process.exit(1);
}
const JWT_SECRET: string = ENV_JWT_SECRET ?? randomBytes(24).toString("hex");
if (ENV_JWT_SECRET === undefined) {
  // Dev-mode autogeneration. The doc-side contract is that the operator
  // copies this line and re-exports it for subsequent runs (otherwise
  // every restart invalidates previously-minted tokens). In production,
  // set CREWHAUS_GATEWAY_JWT_SECRET explicitly.
  console.error(
    \`[managed] no CREWHAUS_GATEWAY_JWT_SECRET in env — generated a one-shot dev secret. Export it to re-use:\\n  export CREWHAUS_GATEWAY_JWT_SECRET=\${JWT_SECRET}\`,
  );
}

// control.v1 — the harness-level (NOT per-tenant) hash-chained audit log every
// control call appends a \`gateway_request\` record to. Per-tenant logs stay the
// record of per-tenant activity; a control call is an operator action against
// the whole daemon. CREWHAUS_SECURITY_AUDIT=0 opts out.
const CONTROL_AUDIT =
  process.env.CREWHAUS_SECURITY_AUDIT === "0"
    ? undefined
    : await openAuditLog({ rootDir: \`\${process.cwd()}/.crewhaus/audit\` });
${controlPlaneBoot}
const TENANT_OVERRIDES: Record<string, Partial<Tenant>> = {
${tenantList}
};

const tenantOverrides: Record<string, Tenant> = {};
for (const [id, override] of Object.entries(TENANT_OVERRIDES)) {
  tenantOverrides[id] = { ...buildTenant(id, { tenantsRoot: TENANTS_ROOT }), ...override };
}

// Budget accounting backend (audit R3). Default in-memory; set
// CREWHAUS_BUDGET_STORE=sqlite:<path> so recorded usage and in-flight
// reservations survive restarts and are shared by every process on this
// host. CAVEAT: durable-state scopes the janitor's boot-time
// clearReservations() to SINGLE-writer deployments — when several writer
// processes share one sqlite store, one process booting would zero the
// others' live reservations, so ALSO set
// CREWHAUS_JANITOR_CLEAR_RESERVATIONS=0 on every process.
const BUDGET_STORE = createBudgetStore(process.env.CREWHAUS_BUDGET_STORE ?? "memory");

// Retention policy (.crewhaus/retention.json, ops item 35): the janitor
// honors the SAME pins + sessions.maxAgeDays the \`crewhaus retention\` CLI
// enforces — a daemon evicting on the bare 30-day default would delete
// sessions the operator pinned or configured to keep longer. A malformed
// config file fails safe: eviction is disabled (never guess a deletion
// policy), and the daemon keeps serving.
let RETENTION_TTL_DAYS: number;
let RETENTION_PINS: readonly string[] = [];
try {
  const retention = await loadRetentionConfig(process.cwd());
  RETENTION_TTL_DAYS = retention.sessionMaxAgeDays;
  RETENTION_PINS = retention.pins;
} catch (err) {
  console.error(
    \`[managed] .crewhaus/retention.json unreadable — janitor session eviction disabled: \${(err as Error).message}\`,
  );
  RETENTION_TTL_DAYS = Number.POSITIVE_INFINITY; // fail-safe: evict nothing
}

// Boot-time self-heal janitor (ops item 36): clears crash-leaked budget
// reservations ONCE at boot (durable-state's documented single-writer boot
// contract — a process that died between tryReserve and release leaks its
// reservation in the sqlite backend; the attempt is boot-only and NEVER
// retried, since a later clear would zero live reservations), evicts
// expired sessions under the retention policy above, and reports orphaned
// tool_use entries in recent transcripts (report-only). Session roots:
// the spec-declared tenants below PLUS every tenant directory under
// TENANTS_ROOT, re-enumerated each run — gateway-server's buildTenant
// fallback serves ANY authenticated tenant id, not just the declared ones.
// CREWHAUS_JANITOR=0 disables entirely; CREWHAUS_JANITOR_INTERVAL_MS
// overrides the hourly re-run (0 keeps only the boot run);
// CREWHAUS_JANITOR_CLEAR_RESERVATIONS=0 skips the reservation clear
// (REQUIRED for multi-writer sqlite deployments — see BUDGET_STORE above).
${dreamStepBlock}${distillStepBlock}const janitor = createJanitor({
  ...(process.env.CREWHAUS_JANITOR_CLEAR_RESERVATIONS !== "0"
    ? { budgetStore: BUDGET_STORE }
    : {}),
  sessionRootDirs: Object.values(tenantOverrides).map((t) => t.sessionRoot),
  tenantsRootDir: TENANTS_ROOT,
  sessionTtlDays: RETENTION_TTL_DAYS,
  pinnedSessionIds: RETENTION_PINS,${dreamStepsField}
});
// control.v1 reports the janitor as a read-only timer lane; per-run outcomes
// past the boot run come from the captured [managed] janitor log lines
// (createJanitor exposes no per-tick callback).
const JANITOR_INTERVAL_MS = Number(process.env.CREWHAUS_JANITOR_INTERVAL_MS ?? 3_600_000);
let __janitorLastRunAt: string | undefined;
if (process.env.CREWHAUS_JANITOR !== "0") {
  const janitorReport = await janitor.runOnce();
  __janitorLastRunAt = new Date().toISOString();
  __control.counters.janitorRuns++;
  console.error(\`[managed] janitor: \${JSON.stringify(janitorReport.steps)}\`);
  janitor.start(JANITOR_INTERVAL_MS);
}
${controlJanitorTimer}

// Ops item 37 — SLO intake gate. The CLI \`run\`/monitor path (registry-backed)
// flips \`.crewhaus/slo/intake.json\` { paused } on a SUSTAINED SLO breach (and
// back to false on recovery). The daemon consults it at request admission and
// sheds load down the same 429 budget_exceeded path while paused. Read is cached
// for 1s so admission stays hot; a missing/corrupt file fails OPEN (admit).
const INTAKE_GATE_PATH = \`\${process.cwd()}/.crewhaus/slo/intake.json\`;
let __intakeCache: { paused: boolean; reason?: string } = { paused: false };
let __intakeCacheAt = 0;
function readIntakeGate(): { paused: boolean; reason?: string } {
  const nowMs = Date.now();
  if (nowMs - __intakeCacheAt < 1000) return __intakeCache;
  __intakeCacheAt = nowMs;
  try {
    const raw = readFileSync(INTAKE_GATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { paused?: unknown; reason?: unknown };
    __intakeCache =
      parsed.paused === true
        ? { paused: true, ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) }
        : { paused: false };
  } catch {
    __intakeCache = { paused: false }; // no/corrupt gate → admit (fail open)
  }
  return __intakeCache;
}

// Contract item 3 — the per-run trace-bus registry that backs runs.subscribe.
// Every run's TraceEventBus is registered under its runId, TENANT-FENCED:
// resolveRunEvents only streams to the tenant that started the run (a
// cross-tenant — or unknown — runId resolves to undefined → 404, so a run's
// existence never leaks across tenants). Bounded so completed runs' ring
// buffers don't accumulate unboundedly; the oldest entry is evicted past the
// cap.
const RUN_BUS_CAP = 256;
const RUN_BUSES = new Map<string, { tenantId: string; bus: RunContext["eventBus"] }>();
function registerRunBus(runId: string, tenantId: string, bus: RunContext["eventBus"]): void {
  RUN_BUSES.set(runId, { tenantId, bus });
  while (RUN_BUSES.size > RUN_BUS_CAP) {
    const oldest = RUN_BUSES.keys().next().value;
    if (oldest === undefined) break;
    RUN_BUSES.delete(oldest);
  }
}

// Loop contract 0.4 (Batch F, ITEM 7) — the resume path's idempotency store.
// runs.continue with a prior sessionId reseats that session's history and is
// wrapped in withIdempotency keyed on (tenant, session, input), so a duplicate
// resume (client retry / a visibility-lease double-pull) returns the cached
// reply instead of re-executing the turn. TTL bounds the dedupe window
// (CREWHAUS_RESUME_IDEM_TTL_MS, default 5 min).
const RESUME_IDEM_STORE = createInMemoryIdempotencyStore<string>();
const RESUME_IDEM_TTL_MS = Number(process.env.CREWHAUS_RESUME_IDEM_TTL_MS ?? 300_000);
${federationSurface.block}
const gateway = createGatewayServer({
  jwtSecret: JWT_SECRET,
  tenantsRoot: TENANTS_ROOT,
  tenantOverrides,
  budgetStore: BUDGET_STORE,
  intakeGate: readIntakeGate,
  // control.v1 — bare unauthenticated GET /healthz (liveness only, no state)
  // plus the 503 + Retry-After intake shed once a drain has been requested.
  // Control routes themselves are NEVER served on this public port.
  publicGate: (__req) => __control.publicGate(__req),${federationSurface.field}
  // Contract item 3 — resolve a run's live trace stream for runs.subscribe from
  // the per-run bus registry, fenced to the owning tenant. Returning undefined
  // (unknown OR cross-tenant runId) makes the gateway answer 404.
  resolveRunEvents: ({ runId, tenant }) => {
    const entry = RUN_BUSES.get(runId);
    if (entry === undefined || entry.tenantId !== tenant.id) return undefined;
    const bus = entry.bus;
    return {
      // Atomic snapshot + live-subscribe: the ring-buffer replay and the live
      // listener attach with no yield between (both synchronous), so no event
      // is dropped or duplicated across the replay→live boundary.
      open: (listener: (event: unknown) => void) => {
        const replay = bus.recent();
        const close = bus.subscribe(listener);
        return { replay, close };
      },
    };
  },
  handler: async ({ method, params, tenant }) => {
    if (method === "runs.create" || method === "runs.continue") {
      const p = params as { input: string; sessionId?: string };
      // The default session id MUST satisfy session-store's id contract
      // (/^sess_[0-9a-f]{16}$/ — see packages/session-store generateId), or the
      // very first store write of a runs.create that omitted sessionId throws
      // and the caller sees internal_error. Mint it exactly the way the store
      // itself does: 8 random bytes, hex-encoded.
      const sessionId = p.sessionId ?? \`sess_\${randomBytes(8).toString("hex")}\`;
      const runId = \`run_\${Math.random().toString(36).slice(2, 10)}\`;
      const log = await gateway.getAuditLog(tenant);
      const policy = evaluatePolicy(
        { toolName: "runChatLoop", sideEffect: "external", input: p.input, tenantId: tenant.id },
      );
      await auditPolicyDecision(log, { toolName: "runChatLoop", input: p.input, tenantId: tenant.id }, policy);
      if (policy.decision === "deny") {
        throw new Error(\`policy denied: \${policy.reason ?? "no reason"}\`);
      }
      // Contract item 3 — mint the run's trace bus up front and register it
      // (tenant-fenced) so runs.subscribe can replay + live-stream THIS run;
      // the SAME context is threaded into runOneTurn so every trace event the
      // run publishes lands on the registered bus, and the response runId is
      // the bus's runId (the id a client subsequently subscribes with).
      // G48 — the per-tenant hash-chained audit log is wired as BOTH the
      // justification and egress durable sinks, so intent-gate and egress
      // verdicts are tamper-evidenced per tenant inside the managed daemon.
      const runContext = createRunContext({ runId, sessionId });
      registerRunBus(runId, tenant.id, runContext.eventBus);
      // Loop contract 0.4 (Batch F, ITEM 7) — runs.continue with a prior
      // sessionId is the RESUME path: reseat that session's history (\`resume\`)
      // and dedupe a duplicate resume via withIdempotency. runs.create (and a
      // continue with no sessionId) always runs a fresh turn.
      const isResume = method === "runs.continue" && p.sessionId !== undefined;
      const executeTurn = async (): Promise<string> =>
        await runOneTurn({
          tenantId: tenant.id,
          sessionId,
          input: p.input${tenantField},
          extraOptions: {
            runContext,
            justificationAuditSink: log,
            egressAuditSink: log,
            ...(isResume ? { resume: { sessionId } } : {}),
          },
        });
      let reply: string;
      try {
        if (isResume) {
          const guarded = withIdempotency<undefined, string>(() => executeTurn(), {
            store: RESUME_IDEM_STORE,
            ttlMs: RESUME_IDEM_TTL_MS,
          });
          const key = idempotencyKey(\`\${tenant.id}:\${sessionId}:\${p.input}\`, 0);
          reply = (await guarded(undefined, key)).value;
        } else {
          reply = await executeTurn();
        }
      } catch (err) {
        // v0.3.0 Goal 6 — a classified terminal failure (billing/auth/…)
        // renders its structured report on the daemon's stderr, then
        // rethrows so the gateway maps it to an error response. The daemon
        // itself keeps serving — one tenant's dead provider account must
        // not take the process down.
        if (isRunFailedError(err)) {
          process.stderr.write(\`\${formatRunFailure(err.report, { prefix: "[managed]" })}\\n\`);
        }
        throw err;
      }
      __control.counters.turns++;
      const inputTokens = Math.ceil(p.input.length / 4);
      const outputTokens = Math.ceil(reply.length / 4);
      await gateway.recordUsage(tenant.id, { input: inputTokens, output: outputTokens });
      await log.append({
        kind: "model_call",
        payload: { tenantId: tenant.id, sessionId, inputTokens, outputTokens },
      });
      return { runId, sessionId, tenantId: tenant.id, reply };
    }
    if (method === "runs.cancel") {
      return { ok: true };
    }
${feedbackHandlerBlock}    if (method === "audit.tail") {
      const log = await gateway.getAuditLog(tenant);
      const rows: unknown[] = [];
      for await (const r of log.read()) rows.push(r);
      return { rows };
    }
    return { ok: true, method };
  },
});

const handle = await gateway.listen(PORT);
console.error(\`[managed] gateway listening on :\${handle.port}\`);
${scheduleWake.helpers}${scheduleWake.block}${controlDrain}${controlStart}
process.on("SIGTERM", async () => {
  console.error("[managed] SIGTERM — closing gateway");
  janitor.stop();${scheduleWake.shutdown}
  await handle.close();
  process.exit(0);
});
process.on("SIGINT", async () => {
  console.error("[managed] SIGINT — closing gateway");
  janitor.stop();${scheduleWake.shutdown}
  await handle.close();
  process.exit(0);
});
`;
}
