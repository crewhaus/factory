import {
  CHEAPEST_SENTINEL,
  DEFAULT_CAPABILITIES,
  type ModelCapabilities,
  type RosterMember,
  STRONGEST_SENTINEL,
  crossesProvider,
  findSunset,
  providerOfSpecString,
  resolveCapabilities,
  resolveCheapestForSlot,
  resolveStrongestForSlot,
  satisfiesCapabilities,
} from "@crewhaus/cost-tracker";
import { CompilerError } from "@crewhaus/errors";
import { assertNever } from "@crewhaus/infra-utils";
import type {
  Bundle,
  EmitReadmeOptions,
  IrBatchV0,
  IrBrowserV0,
  IrBudget,
  IrChainBinding,
  IrChainFinality,
  IrChainGameV0,
  IrChainV0,
  IrChannelV0,
  IrChannels,
  IrCircuitBreaker,
  IrCompaction,
  IrContinuity,
  IrContractBinding,
  IrCrewRole,
  IrCrewV0,
  IrDiscordConfig,
  IrEvalV0,
  IrEvaluation,
  IrExpose,
  IrFailureTaxonomyEntry,
  IrFeedback,
  IrGraphV0,
  IrHook,
  IrIMessageConfig,
  IrJudge,
  IrKnowledge,
  IrLearning,
  IrLimits,
  IrManagedV0,
  IrMcpServerConfig,
  IrMcpServers,
  IrMemory,
  IrModelCapabilities,
  IrModelParams,
  IrModelPool,
  IrModelPoolCandidate,
  IrModelPoolClassifier,
  IrModelPoolReward,
  IrModelPoolRule,
  IrModelPoolStrategy,
  IrModelProfile,
  IrModelProfiles,
  IrModelRequires,
  IrModelTiers,
  IrNode,
  IrObservability,
  IrPermissions,
  IrPipelineV0,
  IrProfilePermissions,
  IrResearchV0,
  IrSchedule,
  IrSecretRef,
  IrSecurity,
  IrSlackConfig,
  IrSubAgentDefinition,
  IrSubAgentProfileOption,
  IrTelegramConfig,
  IrThinking,
  IrThredz,
  IrTransactionPolicy,
  IrV0,
  IrVectorBackend,
  IrVoiceV0,
  IrWalletBinding,
  IrWatchme,
  IrWhatsAppConfig,
  IrWorkflowV0,
} from "@crewhaus/ir";
import { VALIDATING_PASSES, applyPasses as applyIrPassesFn } from "@crewhaus/ir-passes";
import type { ModelProfile, RouteRule } from "@crewhaus/model-plan";
import {
  SPEC_PROFILE_NAME_RE,
  type Spec,
  type SpecChannel,
  type SpecCrewRole,
  type SpecDiscordChannel,
  type SpecIMessageChannel,
  type SpecMcpServerConfig,
  type SpecModelPoolBlock,
  type SpecModelProfile,
  type SpecModelsBlock,
  type SpecObservabilityBlock,
  type SpecSlackChannel,
  type SpecSubAgentDefinition,
  type SpecTelegramChannel,
  type SpecWatchmeBlock,
  type SpecWhatsAppChannel,
  parseSpec,
} from "@crewhaus/spec";
import { emitBatchWorker } from "@crewhaus/target-batch-worker";
import { emitBrowserDriver } from "@crewhaus/target-browser-driver";
import { emitChannelBot } from "@crewhaus/target-channel-bot";
import { emitCli } from "@crewhaus/target-cli";
import { emitCrew } from "@crewhaus/target-crew";
import { emitEval, emitSourceBundleWithEvalEntry } from "@crewhaus/target-eval-bundle";
import { emitGraph } from "@crewhaus/target-graph";
import { emitManaged } from "@crewhaus/target-managed";
import { emitOnchain } from "@crewhaus/target-onchain";
import { emitOnchainGame } from "@crewhaus/target-onchain-game";
import { emitPipeline } from "@crewhaus/target-pipeline";
import { emitResearchBundle } from "@crewhaus/target-research-bundle";
import { emitVoice } from "@crewhaus/target-voice";
import { emitWorkflow } from "@crewhaus/target-workflow";
import { type ScopeFinding, isOutwardName } from "@crewhaus/tool-builder";
// Loop contract 0.4 (Batch F, G12/G83) — the cf-worker edge-safety tool policy
// lives in `@crewhaus/worker-runtime` (the runtime that would execute the
// tools on the edge). Imported via the `/tool-policy` SUBPATH so this offline
// gate never drags the loop into the compiler-worker's CF bundle.
import { partitionEdgeTools } from "@crewhaus/worker-runtime/tool-policy";

/**
 * Compile a YAML spec text into a deployable bundle.
 *
 * Pipeline (slice scope):
 *   parse → validate → lower → emit
 *
 * Future (per catalog F2 compiler-core): pluggable IR passes (dead-tool
 * elimination, profile pruning, prompt-cache prefix sorting), and a
 * bundle-packager step.
 */
export type CompileOptions = {
  /**
   * Section 28 — when true, run the §28 ir-passes pipeline between
   * `lower()` and `emit()`. Default: false (preserves backwards compat).
   * Codegen consumers can opt in once they've validated the passes
   * don't drift outputs.
   */
  readonly applyIrPasses?: boolean;
  /**
   * FR-002 — Pillar 3 sink-side build-time gate. When true, audit every tool
   * NAME the lowered IR references and FAIL the compile (throw `CompilerError`)
   * if any is an outward-reaching sink the compiler cannot verify carries
   * `scope: "external"` offline. Default: false (preserves backwards compat).
   *
   * This is the library-level equivalent of `crewhaus compile --strict`: it
   * makes the gate available to EVERY `compile()` consumer (e.g. the
   * `compiler-worker` Cloudflare Worker that compiles arbitrary user YAML),
   * not just the CLI wrapper. Because the compiler must bundle cleanly into a
   * Worker, it cannot import the heavy built-in tool packages to read live
   * `RegisteredTool.scope`; the IR carries tool NAMES only. So the offline
   * gate keys on `isOutwardName` (shared with `@crewhaus/tool-builder`'s
   * `auditToolScopes`): a `mcp__*` or definitionally-outward built-in name is
   * an external sink whose external scope is unverifiable offline → drift.
   * The CLI's `--strict` additionally resolves names against the local tool
   * map (`auditToolScopes` over real `RegisteredTool`s); both share the same
   * outward-name rule so they cannot diverge.
   */
  readonly strict?: boolean;
  /**
   * Item 42 — emit a generated README.md into the bundle (harness
   * name/target/model, tool table, MCP servers, required env vars, launch
   * snippet — see `renderBundleReadme` in `@crewhaus/ir`). Default: true.
   * `crewhaus compile --no-readme` threads `false` through here.
   */
  readonly readme?: boolean;
  /**
   * Evals Wave 4, cluster S (D36/NEW-shape-1) — `crewhaus compile
   * --with-eval-harness`: emit the shape's PRIMARY bundle in its eval-entry
   * variant (workflow/graph/pipeline gain an exported `runForEval` +
   * `import.meta.main` guard; crew/channel gain an additive `eval-entry.ts`),
   * so the bridged `target: eval` bundle can invoke the shape's real compiled
   * runtime in-process. Shapes that need no re-emission fall through to the
   * ordinary `emit()`, so the bundle is byte-identical for them.
   *
   * It lives HERE, on `compile()`, rather than as a post-hoc re-emission in
   * the CLI: the eval-entry bundle must come out of the SAME pipeline as the
   * plain one (validating passes, and `applyIrPasses` when requested), or the
   * artifact `--with-eval-harness` writes to disk could silently diverge from
   * the artifact a plain compile writes — and that artifact is precisely the
   * runtime the eval then measures. Default: false.
   */
  readonly evalEntry?: boolean;
  /**
   * 0.6.0 §4.3 — the calendar date (`YYYY-MM-DD`) the model-sunset check
   * compares `retiresOn` against. Defaults to today; tests pin it so a
   * compile is deterministic. See {@link LowerOptions.today}.
   */
  readonly today?: string;
};

/**
 * 0.6.0 — options for {@link lower}. Both are optional and default to the
 * `compile()` posture.
 */
export type LowerOptions = {
  /** See {@link CompileOptions.today}. */
  readonly today?: string;
  /**
   * 0.6.0 PR 7 — lower the keys whose runtime consumer has not landed
   * instead of refusing them: `evaluation.on_fail: escalate` and
   * `judge.escalate_to` (PR 9c), and a NARROWING profile (`tools` /
   * `tool_config` / `permissions` / `rate_limits` / `cost`) referenced from a
   * SINGLE-MODEL serving slot (no IR carrier yet — a `model_pool` candidate
   * honours the same knobs since PR 9a). `compile()` and the `crewhaus run`
   * interpreter never set this. Tests and IR-level tooling set it to
   * exercise the lowering the runtime will consume.
   */
  readonly allowRuntimePendingKeys?: boolean;
};

/**
 * Loop contract 0.4 (Batch A, G45 warnings framework) — one non-fatal
 * compile diagnostic. `code` is a stable machine key
 * (`"accepted-but-unwired"`, `"edge-unsafe-tool"`,
 * `"channel-reactions-join"`, `"cli-autodistill-toolchain"`,
 * `"managed-feedback-unsupported"`, `"budget-degrade-outside-pool"`, and from
 * 0.6.0 the field-precise model-plan notices `"model-plan-ignored-on-shape"`,
 * `"model-plan-ignored-on-slot"`, `"model-plan-pending-runtime"`,
 * `"model-plan-self-judge"`, `"model-sunset"`, `"model-capabilities-unknown"`,
 * `"model-strongest-crosses-provider"`), `path` the spec key it concerns
 * (dot-joined), `message` the human explanation. Additive: every existing
 * `compile()` consumer that only reads `.files` keeps working unchanged.
 */
export type CompileWarning = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

/**
 * The result of `compile()`: the emitted {@link Bundle} plus the additive
 * `warnings` array (empty on a clean compile). Structurally a `Bundle`, so
 * callers typed against `Bundle` keep compiling.
 */
export type CompileResult = Bundle & {
  readonly warnings: ReadonlyArray<CompileWarning>;
};

export function compile(yamlText: string, opts: CompileOptions = {}): CompileResult {
  const spec = parseSpec(yamlText);
  const lowered = lowerWithWarnings(spec, opts.today !== undefined ? { today: opts.today } : {});
  let ir = lowered.ir;
  if (opts.strict === true) {
    assertToolScopesStrict(ir);
  }
  // G45 — the VALIDATING ir-passes (graph reachability + edge/message-schema
  // resolution, §47 chain referential integrity, memory/continuity
  // integrity) run UNCONDITIONALLY: they rewrite nothing, so they cannot
  // drift bundle bytes, and a spec that violates referential integrity must
  // fail the build rather than emit a bundle that breaks at runtime.
  // REWRITING passes stay behind `applyIrPasses: true` below.
  for (const pass of VALIDATING_PASSES) {
    ir = pass(ir);
  }
  if (opts.applyIrPasses === true) {
    // Static import so the compiler bundles cleanly into a Cloudflare
    // Worker. ir-passes is a workspace dep regardless; the prior `require`
    // call broke Worker bundling (no `require` in CF Workers runtime).
    // (The full pipeline re-runs the validating passes — they are pure
    // pass-throughs on a valid IR, so the double run is free.)
    ir = applyIrPassesFn(ir);
  }
  // Cluster S — the eval-entry variant is chosen at the SAME point in the
  // pipeline as the ordinary emit (post-passes), so the two bundles cannot
  // drift. `undefined` = this shape needs no re-emission.
  const bundle =
    opts.evalEntry === true
      ? (emitSourceBundleWithEvalEntry(ir, { readme: opts.readme !== false }) ??
        emit(ir, { readme: opts.readme !== false }))
      : emit(ir, { readme: opts.readme !== false });
  return { files: bundle.files, warnings: [...collectCompileWarnings(spec), ...lowered.warnings] };
}

/**
 * Loop contract 0.4 (Batch A) — the ACCEPTED-BUT-UNWIRED table: spec keys a
 * shape's schema accepts (so users can declare them) but whose emitter
 * currently DROPS (or merely prints the 0.2.3-convention ignored-note
 * comment for). Declaring one of these is legal-but-inert config, which
 * beats a strict-union rejection for forward compatibility but deserves a
 * warning so nobody ships dead YAML believing it's live.
 *
 * The table encodes the POST-Batch-A intended state: keys Batch A wires
 * (mcp_servers on crew/research/batch, graph node tools, crew role
 * sub_agents, and limits/thinking/hooks everywhere they're accepted) are
 * deliberately NOT listed. Graph/crew `messageSchemas` are IR-only (no spec
 * key exists), so there is nothing accepted to warn about — they're absent
 * from the table by construction, not by oversight. When an emitter wires
 * a listed key, delete its row (the warnings tests pin the table).
 *
 * Batch B (G02): `evaluation:` on cli/channel/managed and `kind: "judge"`
 * workflow steps / graph nodes are WIRED in this batch (the target emitters
 * and the `crewhaus run` interpreter implement them alongside this
 * lowering), so they are deliberately NOT listed either — declaring them
 * must not warn.
 *
 * Batch E (G22 knowledge / G23 thredz): the `knowledge:` block is WIRED on
 * cli/channel/managed (registered as a Retrieve tool), so it is not listed;
 * `thredz` becomes WIRED on channel + managed this batch (their rows are
 * removed above), while research + crew keep the carried-with-note row.
 *
 * Batch C (G26 observability / G11 pending-approval): the `observability:`
 * block (its new trace/metrics/cost/alerts/incidents/otel sub-blocks) and
 * `permissions.ask_mode` are WIRED-IN-BATCH on the shapes this batch's
 * downstream agents cover — cli / channel / managed / crew (+ the cf-workers
 * trace SSE) — so they are deliberately NOT listed. `observability` is a
 * top-level key already lowered on all four shapes (crew joins them here);
 * `ask_mode` is a sub-key of the universally-wired `permissions` block, and
 * the ACCEPTED_BUT_UNWIRED mechanism tracks top-level keys only, so there is
 * no nested-path row for it — its absent default (`"pause"`) is the safe
 * runtime behaviour on every shape regardless.
 *
 * Batch G: `expose:` (G30, the MCP-server projection) and `plugins:` (G32,
 * the plugin loader) are WIRED-IN-BATCH on the shapes that carry them —
 * expose on cli/channel/managed, plugins on cli/channel — so they are
 * deliberately NOT listed (declaring them must not warn). `federation`
 * (G31) is a sub-key of the universally-wired `sub_agents` block and
 * `thredz.messaging` (G44) a sub-key of the `thredz` block; both are nested
 * paths the top-level-only mechanism does not track, and both are wired this
 * batch regardless. Item 9's per-role/step `model_pool`/`model_tiers`/
 * `model_fallbacks` are nested under `roles`/`steps`, so the top-level-only
 * mechanism cannot carry a row for them. They lower onto `IrWorkflowStep` /
 * `IrCrewRole` and are emit-wired: per step since 0.4 (target-workflow spreads
 * them into the step's `runChatLoop`), per role since 0.6.0 — target-crew has
 * rendered them onto the role's `RoleDefinition` literal since 0.4, but
 * `@crewhaus/crew-orchestrator` only gained the fields and started forwarding
 * them into each role turn in 0.6.0 (PR 3), so on 0.4–0.5 bundles the role's
 * routing was emitted-but-dead config. Lowering alone never wires anything;
 * the consumer does.
 */
type UnwiredKey = {
  readonly path: string;
  readonly message: string;
};

const unwired = (path: string, shape: string, detail: string): UnwiredKey => ({
  path,
  message: `${path} is accepted on the ${shape} shape but its emitter does not wire it yet — ${detail}`,
});

const ACCEPTED_BUT_UNWIRED: Readonly<Partial<Record<Spec["target"], ReadonlyArray<UnwiredKey>>>> = {
  workflow: [
    unwired("continuity", "workflow", "the generated bundle prints the ignored-note comment"),
  ],
  // Loop contract 0.4 (Batch E, G23) — thredz is now emit-WIRED on
  // channel + managed (connectThredz ported from the cli emitter), so their
  // rows are gone; research + crew stay carried-with-note this batch.
  research: [unwired("thredz", "research", "the generated daemon prints the ignored-note comment")],
  // 0.5.0 — crew's row is DELETED, not silenced: thredz is emit-wired on crew
  // now, with the per-role fan-out. The table's contract is that a row exists
  // only while the shape really does ignore the block.
  // Loop contract 0.4 (Batch F) — the `schedule:` block is now emit-WIRED on
  // channel/managed/batch: each daemon arms its wake loop (channel + batch via
  // durable-execution's `armSchedule`, managed via its per-tenant
  // setInterval/cron wake in `renderScheduleWake`), so — per this table's
  // delete-when-wired contract — schedule carries NO accepted-but-unwired row
  // on any shape. channel + managed have no other unwired top-level keys, so
  // they drop out of the table entirely; batch keeps only its continuity row.
  // Managed `agent.tools`/`tool_config` are NESTED keys the top-level-only
  // ACCEPTED_BUT_UNWIRED mechanism does not track, matching how the other
  // shapes' nested `agent.tools` are handled.
  batch: [unwired("continuity", "batch", "the generated bundle prints the ignored-note comment")],
  // "Watch me" (design/watch-me.md §6.3) — the `watchme:` block is WIRED on
  // cli (interpreter env stamp + target-cli bundle preamble) and channel
  // (target-channel-bot's existing G26 env-stamp emitter), so neither shape
  // lists it. managed carries the block parse+lower ONLY: its daemon has no
  // watchme env stamp yet, so managed rejoins the table with the honest row
  // below (delete it when target-managed's one-line `??=` stamp lands).
  managed: [
    unwired(
      "watchme",
      "managed",
      "the managed daemon does not stamp CREWHAUS_WATCHME, so capture stays off until its loop wiring lands (design/watch-me.md §6.3)",
    ),
  ],
  voice: [
    unwired("mcp_servers", "voice", "no MCP host is booted in the voice daemon"),
    unwired("tools", "voice", "the realtime voice loop does not register a tool catalog"),
    unwired("continuity", "voice", "the generated daemon prints the ignored-note comment"),
  ],
  browser: [
    unwired("mcp_servers", "browser", "no MCP host is booted in the browser daemon"),
    unwired("continuity", "browser", "the generated daemon prints the ignored-note comment"),
  ],
  onchain: [unwired("mcp_servers", "onchain", "no MCP host is booted in the onchain daemon")],
  "onchain-game": [
    unwired("mcp_servers", "onchain-game", "no MCP host is booted in the onchain-game daemon"),
  ],
};

/**
 * Whether the spec MEANINGFULLY declares `path` — i.e. the key is present
 * and not an explicit opt-out (`false` / `{enabled: false}`) or an empty
 * collection. Only meaningful declarations warn: `continuity: false` is a
 * live opt-out, not dead config, and an empty `mcp_servers: {}` configures
 * nothing worth warning about.
 */
function specDeclares(spec: Spec, path: string): boolean {
  const value = (spec as unknown as Record<string, unknown>)[path];
  if (value === undefined || value === false) return false;
  if (typeof value === "object" && value !== null) {
    if ((value as { enabled?: unknown }).enabled === false) return false;
    if (Array.isArray(value)) return value.length > 0;
    return Object.keys(value).length > 0;
  }
  return true;
}

function collectCompileWarnings(spec: Spec): ReadonlyArray<CompileWarning> {
  const rows = ACCEPTED_BUT_UNWIRED[spec.target] ?? [];
  const out: CompileWarning[] = [];
  for (const row of rows) {
    if (specDeclares(spec, row.path)) {
      out.push({ code: "accepted-but-unwired", path: row.path, message: row.message });
    }
  }
  // Item 1 (G30) / #394 — `expose:` is wired on cli (via `crewhaus serve
  // --mcp`) and, from 0.5.4, on channel (the bundle mounts its own endpoint).
  // MANAGED still carries it unwired, and the gap is not incidental: the
  // managed daemon's turn function requires a `tenantId` that only the
  // JWT-authenticated request plane resolves, so an MCP mount there needs a
  // tenancy decision this emit does not make. Saying so beats letting the
  // block look live — which is exactly how #394 was found.
  if (spec.target === "managed" && spec.expose?.mcp !== undefined) {
    out.push({
      code: "accepted-but-unwired",
      path: "expose.mcp",
      message: [
        "expose.mcp is accepted on managed but NOT wired: the emitted daemon mounts no MCP",
        "endpoint (its turn function is tenant-scoped, and which tenant an MCP caller drives",
        "is undecided). Project this agent with `crewhaus serve --mcp` against a cli spec, or",
        "use the channel shape, which does self-expose.",
      ].join(" "),
    });
  }
  // #394 — `transport: stdio` on a DAEMON shape mounts nothing: stdio is the
  // `crewhaus serve --mcp` projection, where the CLI owns the process's stdio.
  // A daemon has no such channel, so the block is inert — which is precisely
  // the silence this whole change exists to end, so it says so.
  if (
    (spec.target === "channel" || spec.target === "managed") &&
    spec.expose?.mcp?.transport === "stdio"
  ) {
    out.push({
      code: "accepted-but-unwired",
      path: "expose.mcp.transport",
      message: [
        'expose.mcp.transport: "stdio" mounts nothing on a daemon — stdio is the',
        "`crewhaus serve --mcp` projection, which needs a process whose stdio is the",
        'protocol channel. Use `transport: "sse"` to self-expose from the compiled',
        "bundle (channel), or project a cli spec with `crewhaus serve --mcp`.",
      ].join(" "),
    });
  }
  // #394 — `per-subagent` cannot be honoured on channel: the projected tools
  // are meant to ROUTE to a sub-agent, and the channel turn function takes no
  // routing argument, so every projected tool would land in the same
  // undirected turn. The emit projects `chat` and says so here rather than
  // advertising N identical tools under N names.
  if (spec.target === "channel" && spec.expose?.mcp?.tools === "per-subagent") {
    out.push({
      code: "accepted-but-unwired",
      path: "expose.mcp.tools",
      message: [
        'expose.mcp.tools: "per-subagent" is accepted on channel but projects as "chat":',
        "the channel turn function has no sub-agent routing parameter, so per-sub-agent tools",
        "would all drive the same undirected turn. The bundle exposes one `chat` tool;",
        "sub-agents still run inside it exactly as they do for an inbound message.",
      ].join(" "),
    });
  }
  // Item 1 — a compiled cli bundle DOES capture ratings (the runtime asks the
  // exit rating prompt and appends the same `user_feedback` events
  // `crewhaus rate` writes), but it does NOT auto-distill them: registering a
  // VERSIONED `<spec>-ratings` registry dataset exists to be consumed by
  // `crewhaus eval`/`optimize`, so it stays a toolchain step in the CLI's run
  // teardown. Saying so at compile time beats letting a bundle look like it
  // maintains the dataset when nothing in it does.
  if (spec.target === "cli" && spec.feedback?.autoDistill === true) {
    out.push({
      code: "cli-autodistill-toolchain",
      path: "feedback.autoDistill",
      message: [
        "the compiled bundle CAPTURES ratings (exit rating prompt → user_feedback events in",
        ".crewhaus/sessions) but does not auto-distill them into the",
        `\`${spec.name}-ratings\` registry dataset — that runs in the CLI teardown.`,
        "Distill a bundle's accumulated ratings with `crewhaus distill --register`,",
        "or drive the harness with `crewhaus run`",
      ].join(" "),
    });
  }
  // D40 — channel 👍/👎 reactions attribute to the exact reacted-to turn
  // through the outbound-ts join store the generated daemon appends as it
  // posts replies (target-channel-bot's session-router). The join only
  // covers replies posted once the daemon runs this build, so day-one
  // reactions on older messages degrade; one honest compile-time heads-up
  // beats silently-degraded attribution semantics.
  if (spec.target === "channel" && spec.feedback?.channelReactions === true) {
    out.push({
      code: "channel-reactions-join",
      path: "feedback.channelReactions",
      message:
        "reaction feedback attributes to the exact reacted-to turn via the outbound-ts join file " +
        "(.crewhaus/feedback/joins/channel.jsonl) the daemon appends as it posts replies — the join " +
        "must accumulate first, so reactions on messages posted by older builds fall back to " +
        "last-turn attribution (sessionKey channel/user) or are dropped (sessionKey thread)",
    });
  }
  // NEW-inloop-coverage — `feedback:` now parses on the managed shape, but
  // two of its switches describe surfaces the gateway daemon does not have.
  // Say so at compile time rather than letting a spec look like it configured
  // something (the parsed-but-dead trust hole strict schemas exist to close).
  if (spec.target === "managed" && spec.feedback !== undefined) {
    if (spec.feedback.exitPrompt !== undefined) {
      out.push({
        code: "managed-feedback-unsupported",
        path: "feedback.exitPrompt",
        message:
          "the managed gateway has no REPL to exit — the exit rating prompt is a cli-shape surface. " +
          "The gateway captures ratings through its `feedback.submit` JSON-RPC method instead",
      });
    }
    if (spec.feedback.channelReactions !== undefined) {
      out.push({
        code: "managed-feedback-unsupported",
        path: "feedback.channelReactions",
        message:
          "inbound 👍/👎 reactions are the channel shape's capture surface; the managed gateway " +
          "captures ratings through its `feedback.submit` JSON-RPC method instead",
      });
    }
  }
  // 0.6.0 §7.12 — `budget.on_exceed.degrade.model` outside the `model_pool`
  // roster. No refine forbids `budget` beside `model_pool` (the mutual-
  // exclusion refine sees only the `agent` sub-object; `budget` is a
  // top-level sibling), and such specs parse, compile and run today — so
  // this is a WARNING, never a parse error. The runtime pre-resolves the
  // degrade model as one extra, always-eligible pool rung and forces it on a
  // breach (`model_route` policy `forced`, reason `budget_degrade`). This
  // code is NOT in the `compile --strict` failure class: strict fails only
  // the tool-scope audit, and a deliberate off-roster cheap rung is a valid
  // configuration the author may want.
  const degradeOutsidePool = budgetDegradeOutsidePool(spec);
  if (degradeOutsidePool !== undefined) {
    out.push({
      code: "budget-degrade-outside-pool",
      path: "budget.on_exceed.model",
      message: [
        `budget.on_exceed.model "${degradeOutsidePool.model}" is not one of the agent.model_pool`,
        `candidates (${degradeOutsidePool.roster.join(", ")}) — on a budget breach the runtime`,
        "forces this model as an EXTRA pool rung (routing restricted to it), outside the pool's",
        "declared roster and its learned arms. Add it to model_pool.candidates to make the rung",
        "part of the roster, or point degrade.model at an existing candidate.",
      ].join(" "),
    });
  }
  return out;
}

/**
 * 0.6.0 §7.12 — the `budget.on_exceed: degrade` model vs. the pool roster.
 * Returns the offending model + roster when a spec declares BOTH a degrade
 * ladder and an `agent.model_pool` whose candidates do not include the
 * degrade model; `undefined` otherwise (no budget, `stop`, no pool, or a
 * roster member). Structural read over the union so every pool-carrying
 * shape (cli / channel / managed / research / batch / browser) is covered.
 */
function budgetDegradeOutsidePool(
  spec: Spec,
): { readonly model: string; readonly roster: readonly string[] } | undefined {
  const view = spec as unknown as {
    readonly budget?: {
      readonly on_exceed?: { readonly action: string; readonly model?: string };
    };
    readonly agent?: {
      readonly model_pool?: { readonly candidates?: ReadonlyArray<{ readonly model: string }> };
    };
  };
  const onExceed = view.budget?.on_exceed;
  if (onExceed === undefined || onExceed.action !== "degrade" || onExceed.model === undefined) {
    return undefined;
  }
  const candidates = view.agent?.model_pool?.candidates;
  if (candidates === undefined) return undefined;
  const roster = candidates.map((c) => c.model);
  if (roster.includes(onExceed.model)) return undefined;
  return { model: onExceed.model, roster };
}

/**
 * FR-002 — collect every tool NAME referenced anywhere in a lowered IR,
 * variant-agnostically. The IR is a JSON-serializable discriminated union;
 * some variants carry tools at the top level (`IrV0.tools`), others nest them
 * under steps / nodes / roles / sub-agents. Rather than couple to each
 * variant's shape, walk the object and gather every string under a `tools`
 * key. Deterministic and dedup'd.
 */
function collectToolNames(ir: unknown): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "tools" && Array.isArray(value)) {
          for (const v of value) if (typeof v === "string") names.add(v);
        }
        visit(value);
      }
    }
  };
  visit(ir);
  return [...names];
}

/**
 * FR-002 — the offline `strict` scope audit over a lowered IR's tool names.
 * Throws `CompilerError` (extends `CrewhausError`, so a CLI catch routes it
 * through `die()`) listing every outward-by-name sink that cannot be verified
 * `scope: "external"` offline. A spec referencing `mcp__evil__exfiltrate` (or
 * any outward built-in name) no longer slips through a non-CLI `compile()`.
 *
 * Exported so a consumer that drives `lower()` + an emitter directly — rather
 * than going through `compile({ strict: true })` — can apply the SAME offline
 * gate over its already-lowered IR (e.g. the compiler-worker's `cf-worker`
 * emit branch), instead of re-deriving the rule and risking drift.
 */
export function assertToolScopesStrict(ir: IrNode): void {
  const findings: ScopeFinding[] = [];
  for (const name of collectToolNames(ir)) {
    if (isOutwardName(name)) {
      findings.push({
        toolName: name,
        reason:
          'is an outward-reaching sink by name but its scope cannot be verified "external" at compile time (dynamic/MCP sinks must be vetted, not assumed)',
      });
    }
  }
  if (findings.length > 0) {
    const detail = findings.map((f) => `tool "${f.toolName}" ${f.reason}`).join("; ");
    throw new CompilerError(
      `[strict] ${findings.length} scope finding(s) — refusing to emit: ${detail}. Set scope: "external" on each tool, or compile without { strict: true } to bypass the gate.`,
    );
  }
}

/**
 * Loop contract 0.4 (Batch F, G12/G83) — the cf-worker tool-allow gate.
 *
 * The cf-worker emitters USED to reject ANY tool at compile time ("does not
 * yet support tools"). Now that the deployed path runs the real
 * `@crewhaus/worker-runtime` loop, tools are ALLOWED — but only the edge-safe
 * ones. This gate (the cf-worker analog of {@link assertToolScopesStrict})
 * partitions a lowered IR's tool names through the single-source-of-truth
 * `partitionEdgeTools` policy and:
 *   - THROWS `CompilerError` when any HOST tool (bash/fs/code-execution/…)
 *     is referenced — those cannot run on a stateless Worker, so a clear
 *     compile error beats a bundle that 500s at runtime;
 *   - RETURNS `CompileWarning`s (code `"edge-unsafe-tool"`) for unrecognised
 *     CUSTOM tools whose edge-safety the compiler cannot verify offline —
 *     permitted, but flagged so a host-reaching custom tool is not shipped
 *     silently.
 *
 * Exported for the cf-worker emit paths (the three `target-cf-worker-*`
 * emitters + the compiler-worker's `cf-worker` branch) to call in place of
 * the old blanket rejection, over their already-lowered IR — so the
 * edge-safety rule has one home and cannot drift per emitter.
 */
export function assertCfWorkerToolsEdgeSafe(ir: IrNode): ReadonlyArray<CompileWarning> {
  const { rejected, warned } = partitionEdgeTools(collectToolNames(ir));
  if (rejected.length > 0) {
    const detail = rejected.map((r) => r.reason).join("; ");
    throw new CompilerError(
      `cf-worker target cannot run ${rejected.length} host tool(s): ${detail}. These need a host (process/filesystem/sandbox/device) the edge does not provide — use the cli target for them, or remove them.`,
    );
  }
  return warned.map((w) => ({ code: "edge-unsafe-tool", path: "tools", message: w.warning }));
}

type SpecWithPermissions = Exclude<Spec, { target: "eval" }>;
/**
 * Phase 3 §3.1 — parse a duration string ("2h", "30m", "60s", "500ms";
 * v0.3.0 adds "90d") to milliseconds. Caller is expected to have already
 * regex-validated the format at the spec layer; this is the
 * deterministic numeric step. Shared by `heartbeat.every` and the v0.3.0
 * `memory.ttl` lowering.
 */
const DURATION_UNIT_MS: Record<"ms" | "s" | "m" | "h" | "d", number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};
function parseDurationToMs(duration: string): number {
  const m = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!m) {
    throw new Error(`invalid duration "${duration}" (caught past spec validation)`);
  }
  const n = Number.parseInt(m[1] ?? "0", 10);
  // The capture group is statically one of the table's keys (the regex permits
  // no other unit), so the lookup is total — no unreachable default arm.
  return n * DURATION_UNIT_MS[m[2] as keyof typeof DURATION_UNIT_MS];
}

function lowerPermissions(spec: SpecWithPermissions): IrPermissions {
  const p = spec.permissions;
  if (p === undefined) return { rules: [] };
  return {
    mode: p.mode,
    // Loop contract 0.4 (Batch C, G11) — carry `ask_mode` only when the spec
    // sets it (mirrors `mode`): absent means the SAFE default `"pause"`, which
    // the runtime resolves with `askMode ?? "pause"`. NOT optimizer-reachable
    // (a safety control, excluded from OPTIMIZABLE_PATHS at the spec layer).
    ...(p.ask_mode !== undefined ? { askMode: p.ask_mode } : {}),
    rules: (p.rules ?? []).map(
      (r: { type: IrPermissions["rules"][number]["type"]; pattern: string }) => ({
        type: r.type,
        pattern: r.pattern,
      }),
    ),
  };
}

/**
 * Normalise mcp_servers from spec (where args/env/headers are optional) to
 * IR (where args is a required readonly array — env/headers stay optional).
 *
 * 0.3.0 — stdio `env` and sse `headers` VALUES route through the Section-12
 * secret machinery instead of being copied verbatim (which used to bake the
 * literal string `"$THREDZ_API_KEY"` into compiled bundles, with no runtime
 * resolution — the blocker for delivering any secret into an MCP child
 * process). Each value lowers with `lowerSecret` (permissive: plain strings
 * stay literals, `$UPPER_SNAKE` becomes an env ref), upgraded to
 * `lowerCredential` (fail-fast on a malformed `$…` ref) when the KEY is
 * credential-shaped — `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD`, or
 * the `Authorization` / `x-api-key` header names. Target codegen embeds the
 * unresolved config and emitted bundles resolve it at process start via
 * `resolveMcpServerConfig` from `@crewhaus/mcp-host`.
 */
const CREDENTIAL_SHAPED_KEY_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;
const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set(["authorization", "x-api-key"]);

function lowerMcpSecretMap(
  map: Readonly<Record<string, string>>,
  labelPrefix: string,
  kind: "env" | "headers",
): Readonly<Record<string, IrSecretRef>> {
  const out: Record<string, IrSecretRef> = {};
  for (const [key, value] of Object.entries(map)) {
    const credentialShaped =
      CREDENTIAL_SHAPED_KEY_RE.test(key) ||
      (kind === "headers" && CREDENTIAL_HEADER_NAMES.has(key.toLowerCase()));
    out[key] = credentialShaped
      ? lowerCredential(`${labelPrefix}.${kind}.${key}`, value)
      : lowerSecret(value);
  }
  return out;
}

function lowerMcpServers(specMcp: Record<string, SpecMcpServerConfig> | undefined): IrMcpServers {
  if (specMcp === undefined) return Object.freeze({}) as IrMcpServers;
  const out: Record<string, IrMcpServerConfig> = {};
  for (const [name, cfg] of Object.entries(specMcp)) {
    // #406 — carried ONLY when the spec opted out of fail-fast, so a spec
    // without the key lowers byte-identically.
    const optional = cfg.required === false ? ({ required: false } as const) : {};
    if (cfg.transport === "stdio") {
      out[name] = {
        transport: "stdio",
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.env !== undefined
          ? { env: lowerMcpSecretMap(cfg.env, `mcp_servers.${name}`, "env") }
          : {}),
        ...optional,
      };
    } else {
      out[name] = {
        transport: "sse",
        url: cfg.url,
        ...(cfg.headers !== undefined
          ? { headers: lowerMcpSecretMap(cfg.headers, `mcp_servers.${name}`, "headers") }
          : {}),
        ...optional,
      };
    }
  }
  return Object.freeze(out) as IrMcpServers;
}

/**
 * Section 12 — convert a spec secret string into an IrSecretRef. Strings of
 * the form `$VAR_NAME` (where VAR_NAME matches `[A-Z_][A-Z0-9_]*`) become
 * env-var references; everything else is treated as a literal. Done at
 * lower-time, NOT spec-parse-time, so the env lookup happens in the
 * compiled bundle's `process.env` at runtime — keeping real secrets out
 * of compiled artifacts checked into git.
 */
const ENV_REF_RE = /^\$([A-Z_][A-Z0-9_]*)$/;
function lowerSecret(raw: string): IrSecretRef {
  const m = raw.match(ENV_REF_RE);
  if (m && typeof m[1] === "string") {
    return { kind: "env", name: m[1] };
  }
  return { kind: "literal", value: raw };
}

/**
 * Section 12 (companion to `lowerSecret`) — lower a *credential-shaped* field
 * (channel bot tokens, signing secrets, retrieval API keys). Identical to
 * `lowerSecret` for a valid `$VAR_NAME` env reference or a genuine literal,
 * but a value that *looks like* an env reference — it starts with `$` — yet is
 * not a valid one is almost always a typo'd env ref (`$slack_token`,
 * `$1PASSWORD`, `${SLACK_BOT_TOKEN}`). Left alone it would be silently baked
 * into the compiled bundle as a literal string, shipping a broken credential
 * that only fails at runtime auth. We fail compilation with a clear message
 * instead — the same fail-fast stance `lowerWalletKeyRef` takes for signing
 * keys (#159). `label` is the field path used in the diagnostic. Path-like and
 * URL fields keep the permissive `lowerSecret` (a literal `$HOME/...` path is
 * legitimate), so the strict check is scoped to fields that carry secrets.
 */
function lowerCredential(label: string, raw: string): IrSecretRef {
  const m = raw.match(ENV_REF_RE);
  if (m && typeof m[1] === "string") {
    return { kind: "env", name: m[1] };
  }
  if (raw.startsWith("$")) {
    throw new CompilerError(
      `${label} value ${JSON.stringify(raw)} looks like an environment reference but is not a valid one. Environment references must be $UPPER_SNAKE_CASE (e.g. $SLACK_BOT_TOKEN) — no lowercase, no leading digit, no \${...} braces. Fix the variable name, or remove the leading "$" if this is genuinely a literal value.`,
    );
  }
  return { kind: "literal", value: raw };
}

/**
 * Section 47 (#159, CWE-798) — lower a wallet `keyRef` with a stricter
 * policy than `lowerSecret`. A signing key MUST be an indirection — an
 * `$ENV_REF` (resolved from `process.env` in the compiled bundle) or a
 * `kms://` / `hsm://` handle that names a key the custody backend holds.
 * A literal value (especially a raw hex private key) would be baked
 * verbatim into the DO-NOT-EDIT `agent.ts` artifact, so we fail
 * compilation rather than emit a secret into a checked-in file.
 */
const KEY_HANDLE_RE = /^(kms|hsm):\/\/.+/;
const RAW_HEX_PRIVATE_KEY_RE = /^0x?[0-9a-fA-F]{64}$/;
function lowerWalletKeyRef(walletId: string, raw: string): IrSecretRef {
  const m = raw.match(ENV_REF_RE);
  if (m && typeof m[1] === "string") {
    return { kind: "env", name: m[1] };
  }
  if (RAW_HEX_PRIVATE_KEY_RE.test(raw)) {
    throw new Error(
      `wallet "${walletId}" keyRef looks like a raw private key — never embed signing keys in a spec. Use an environment reference (e.g. keyRef: $WALLET_KEY) or a kms:// / hsm:// handle.`,
    );
  }
  if (KEY_HANDLE_RE.test(raw)) {
    return { kind: "literal", value: raw };
  }
  throw new Error(
    `wallet "${walletId}" keyRef "${raw}" is not a permitted signing-key reference. Use an environment reference (e.g. keyRef: $WALLET_KEY) or a kms:// / hsm:// handle.`,
  );
}

function lowerSlack(slack: SpecSlackChannel): IrSlackConfig {
  return {
    botToken: lowerCredential("channels.slack.botToken", slack.botToken),
    signingSecret: lowerCredential("channels.slack.signingSecret", slack.signingSecret),
    ...(slack.appToken !== undefined
      ? { appToken: lowerCredential("channels.slack.appToken", slack.appToken) }
      : {}),
  };
}

function lowerTelegram(telegram: SpecTelegramChannel): IrTelegramConfig {
  return {
    botToken: lowerCredential("channels.telegram.botToken", telegram.botToken),
    secretToken: lowerCredential("channels.telegram.secretToken", telegram.secretToken),
  };
}

function lowerDiscord(discord: SpecDiscordChannel): IrDiscordConfig {
  return {
    applicationId: lowerCredential("channels.discord.applicationId", discord.applicationId),
    botToken: lowerCredential("channels.discord.botToken", discord.botToken),
    publicKeyHex: lowerCredential("channels.discord.publicKeyHex", discord.publicKeyHex),
  };
}

function lowerWhatsApp(whatsapp: SpecWhatsAppChannel): IrWhatsAppConfig {
  return {
    phoneNumberId: lowerCredential("channels.whatsapp.phoneNumberId", whatsapp.phoneNumberId),
    accessToken: lowerCredential("channels.whatsapp.accessToken", whatsapp.accessToken),
    appSecret: lowerCredential("channels.whatsapp.appSecret", whatsapp.appSecret),
    ...(whatsapp.verifyToken !== undefined
      ? { verifyToken: lowerCredential("channels.whatsapp.verifyToken", whatsapp.verifyToken) }
      : {}),
  };
}

function lowerIMessage(imessage: SpecIMessageChannel): IrIMessageConfig {
  return {
    ...(imessage.chatDbPath !== undefined ? { chatDbPath: lowerSecret(imessage.chatDbPath) } : {}),
    ...(imessage.cursorPath !== undefined ? { cursorPath: lowerSecret(imessage.cursorPath) } : {}),
  };
}

function lowerChannels(channels: SpecChannel["channels"]): IrChannels {
  return {
    ...(channels.slack !== undefined ? { slack: lowerSlack(channels.slack) } : {}),
    ...(channels.telegram !== undefined ? { telegram: lowerTelegram(channels.telegram) } : {}),
    ...(channels.discord !== undefined ? { discord: lowerDiscord(channels.discord) } : {}),
    ...(channels.whatsapp !== undefined ? { whatsapp: lowerWhatsApp(channels.whatsapp) } : {}),
    ...(channels.imessage !== undefined ? { imessage: lowerIMessage(channels.imessage) } : {}),
  };
}

/**
 * Section 13 — convert a spec sub_agents map to a deterministic IR array.
 * The map key becomes the `name` field. Defaults applied at lower-time:
 *   - permissions ?? "inherit"
 *   - inherit_bypass ?? false
 *   - tools ?? []  (codegen treats "no tools" as "no allowed tools" when
 *                   permissions !== "inherit"; tool-task itself encodes
 *                   the same fallback for runtime resolution.)
 *
 * 0.6.0 §7.7 — a sub-agent's `model` resolves through the registry like any
 * serving slot (`agent-full`: a profile's params and failover chain apply, its
 * overlay folds into the child's instructions), and the child carries its own
 * routing quartet, params, `budget_share`, `inherit_routing` and
 * `allowed_profiles`. Each allowed profile is resolved HERE to the serving slot
 * the child runs on when the Task call pins it (`IrSubAgentProfileOption`), so
 * the registry stays provenance-only downstream. The spawner consumes every one
 * of these keys (0.6.0 PR 11); a spec that declares none of them lowers
 * byte-identically.
 */
function lowerSubAgents(
  map: Record<string, SpecSubAgentDefinition> | undefined,
  ctx: LowerContext,
  path: string,
): IrSubAgentDefinition[] {
  if (map === undefined) return [];
  // Stable order: sort by name so generated bundles diff cleanly.
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([name, def]) => {
    const p = `${path}.sub_agents.${name}`;
    const hasRouting =
      def.model_pool !== undefined ||
      def.model_tiers !== undefined ||
      def.model_fallbacks !== undefined;
    const local: SingleSlotLocal = {
      ...lowerThinking(def.thinking),
      ...(def.max_tokens !== undefined ? { maxTokens: def.max_tokens } : {}),
      ...(def.temperature !== undefined ? { temperature: def.temperature } : {}),
      hasRouting,
    };
    const slot =
      def.model !== undefined
        ? applyProfileToSlot(
            resolveModelRef(def.model, ctx, `${p}.model`),
            ctx,
            `${p}.model`,
            "agent-full",
            local,
          )
        : undefined;
    const routing = lowerModelFailover(def, ctx, p);
    const allowedProfiles = def.allowed_profiles?.map((entry, i): IrSubAgentProfileOption => {
      const profile = profileRefName(entry);
      if (profile === undefined || ctx.registry[profile] === undefined) {
        throw new CompilerError(
          `${p}.allowed_profiles[${i}]: "${entry}" must name a declared models: profile (as $<name>)`,
        );
      }
      // The option is the profile applied to a serving slot with NO local
      // overrides — exactly what `model: $<profile>` on this child would
      // lower to — so a pinned Task call runs on the profile's own params and
      // failover chain. The overlay is carried (not folded): it applies to
      // the child's prompt only when this profile is the one chosen.
      const optPath = `${p}.allowed_profiles[${i}]`;
      const slot = applyProfileToSlot(
        resolveModelRef(entry, ctx, optPath),
        ctx,
        optPath,
        "agent-full",
      );
      return {
        profile,
        model: slot.model,
        ...(slot.thinking !== undefined ? { thinking: slot.thinking } : {}),
        ...(slot.maxTokens !== undefined ? { maxTokens: slot.maxTokens } : {}),
        ...(slot.temperature !== undefined ? { temperature: slot.temperature } : {}),
        ...(slot.overlay !== undefined ? { overlay: slot.overlay } : {}),
        ...servingSlotFailover(slot),
      };
    });
    const lowered: IrSubAgentDefinition = {
      name,
      description: def.description,
      instructions: foldOverlay(def.instructions, slot?.overlay),
      tools: def.tools ?? [],
      ...(slot !== undefined ? { model: slot.model } : {}),
      permissions: def.permissions ?? "inherit",
      inheritBypass: def.inherit_bypass ?? false,
      // Item 2 (G31) — federated-peer reference. Carried only when declared; the
      // spawner routes through the federation-router when present.
      ...(def.federation !== undefined ? { federation: { url: def.federation.url } } : {}),
      // 0.6.0 §7.7 — per-sub-agent params + routing (declared, or the profile's).
      ...(slot !== undefined
        ? servingSlotFields(slot)
        : {
            ...(local.thinking !== undefined ? { thinking: local.thinking } : {}),
            ...(local.maxTokens !== undefined ? { maxTokens: local.maxTokens } : {}),
            ...(local.temperature !== undefined ? { temperature: local.temperature } : {}),
          }),
      ...routing,
      ...(slot !== undefined ? servingSlotFailover(slot) : {}),
      ...(def.budget_share !== undefined ? { budgetShare: def.budget_share } : {}),
      ...(def.inherit_routing !== undefined ? { inheritRouting: def.inherit_routing } : {}),
      ...(allowedProfiles !== undefined ? { allowedProfiles } : {}),
    };
    return lowered;
  });
}

/**
 * Item 1 (G30) — lower the `expose:` block to `IrExpose`, resolving the MCP
 * tool-projection default (`tools: "chat"`). Present ONLY when the spec
 * declares `expose.mcp`; returns `{}` otherwise so the field stays ABSENT
 * (emitters gate on presence — an unexposed bundle is byte-identical to
 * pre-Batch-G). Carried on the serving shapes (cli/channel/managed).
 */
function lowerExpose(spec: {
  readonly expose?: {
    readonly mcp?: {
      readonly transport: "stdio" | "sse";
      readonly tools?: "chat" | "per-subagent";
    };
  };
}): { expose?: IrExpose } {
  const mcp = spec.expose?.mcp;
  if (mcp === undefined) return {};
  return { expose: { mcp: { transport: mcp.transport, tools: mcp.tools ?? "chat" } } };
}

/**
 * Item 3 (G32) — lower the `plugins:` list. Carried only when non-empty so an
 * empty (or absent) declaration leaves bundles byte-identical; order is
 * preserved (load order). Carried on the codegen-serving shapes (cli/channel).
 */
function lowerPlugins(spec: { readonly plugins?: readonly string[] }): {
  plugins?: readonly string[];
} {
  return spec.plugins !== undefined && spec.plugins.length > 0
    ? { plugins: [...spec.plugins] }
    : {};
}

/**
 * Section 14 — freeze a spec `tool_config` map into the IR shape. Empty
 * default (`{}`) so codegen never needs `?? {}` guards.
 */
function lowerToolConfigs(
  raw: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> {
  if (raw === undefined) return Object.freeze({});
  return Object.freeze({ ...raw });
}

/**
 * Section 17 — normalise the optional `compaction` block. Always produce
 * an object so codegen can read `ir.compaction.model` safely. When the
 * spec omits the block entirely, the IR carries an empty object — runtime
 * resolves to "use the agent's primary model" in that case.
 *
 * 0.6.0 §4.3 — `compaction.model` is an AUXILIARY slot: `$profile`,
 * `cheapest` and `strongest` all resolve through {@link resolveAuxSlot}; a
 * profile's pinned request params ride `params` for the autocompact request
 * builder, with the profile name beside them as provenance.
 */
function lowerCompaction(spec: SpecWithPermissions, ctx: LowerContext): IrCompaction {
  const c = spec.compaction;
  if (c === undefined) return {};
  // Propagate each defined field verbatim. Defaults belong at the
  // consumer site (curator's `DEFAULT_DEDUPE_THRESHOLD`, autocompact's
  // primary-model fallback) so the IR carries the user's intent
  // without lying about defaults.
  const out: {
    -readonly [K in keyof IrCompaction]: IrCompaction[K];
  } = {};
  if (c.model !== undefined) {
    const slot = resolveAuxSlot(c.model, ctx, "compaction.model");
    out.model = slot.model;
    if (slot.modelProfile !== undefined) out.modelProfile = slot.modelProfile;
    if (slot.params !== undefined) out.params = slot.params;
  }
  // Loop contract 0.4 (Batch A) — threshold + snip window, snake_case spec
  // keys renamed to camelCase IR keys, carried verbatim only when declared.
  if (c.threshold !== undefined) out.threshold = c.threshold;
  if (c.snip_keep_head !== undefined) out.snipKeepHead = c.snip_keep_head;
  if (c.snip_keep_tail !== undefined) out.snipKeepTail = c.snip_keep_tail;
  if (c.curate !== undefined) out.curate = c.curate;
  if (c.dedupeThreshold !== undefined) out.dedupeThreshold = c.dedupeThreshold;
  if (c.relevanceTopK !== undefined) out.relevanceTopK = c.relevanceTopK;
  return out;
}

// ---------------------------------------------------------------------------
// 0.6.0 §4.3 — model references, sentinels, profiles and the per-slot
// contract.
//
// A `$<profile>` reference is a LOWER-TIME MACRO (design stance 1): on a
// single-model slot it expands into the existing IR fields (`model`,
// `thinking`, `maxTokens`, plus `temperature`) and a provenance-only
// `modelProfile` name; an overlay folds into `instructions`; nothing
// downstream of the compiler ever sees a `$`. Only a `model_pool` candidate
// carries the whole profile to runtime, inside the one
// `JSON.stringify(modelPool)` blob every emitter already writes. The
// `cheapest` sentinel keeps its item-25 semantics; `strongest` (§4.3)
// resolves ROSTER-FIRST — the first `strong`-tagged profile or candidate,
// else the last declared — and by price rank only for a bare single-model
// spec, never inside a roster member's own `model:` (the circularity rule).
//
// Everything a slot cannot honour is reported FIELD-PRECISELY as a
// `compile()` warning (never an `ACCEPTED_BUT_UNWIRED` row — that table is a
// top-level-key mechanism whose canned sentence would be false for a spec
// whose model the registry supplied):
//   - `model-plan-ignored-on-shape`  — the shape has no home for the field
//     (voice registers no tool catalog, pipeline has no thinking, …);
//   - `model-plan-ignored-on-slot`   — the field is pool-candidate / primary
//     semantics and has no meaning on this slot (a judge, a tier, a fallback);
//   - `model-plan-pending-runtime`   — lowered into the IR, but the runtime
//     consumer lands with a later 0.6.0 PR-train row; inert until then. The
//     landing PR deletes the row, exactly the ACCEPTED_BUT_UNWIRED
//     delete-when-wired contract applied at field level.
//
// One class is REFUSED rather than warned until its runtime lands:
// `evaluation.on_fail: escalate` and `judge.escalate_to` (PR 9c), and the
// NARROWING knobs (`tools` / `tool_config` / `permissions` / `rate_limits` /
// `cost`) of a profile referenced from a SINGLE-MODEL serving slot — the IR
// has no per-candidate plan carrier for a slot that routes no pool, so the
// runtime could not honour them and accepting them would serve a profile
// declared `tools: []` with the full toolset. The same knobs on a
// `model_pool` CANDIDATE (inline or inherited from a `$profile`) lower and
// compile through since PR 9a: runtime-core builds a per-candidate plan
// (subset advertisement + dispatch gate, narrowed permissions, rate buckets,
// per-call tool_config, spend cap) from the pool blob at boot.
// `LowerOptions.allowRuntimePendingKeys` lowers the refused keys anyway
// (tests, IR tooling); `compile()` never sets it. `mcp_servers.<n>.tool_flags`
// has no PR-train row for its IR + emit half yet and stays refused too.
// ---------------------------------------------------------------------------

type LooseBlock = Readonly<Record<string, unknown>>;

function asLooseBlock(value: unknown): LooseBlock | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as LooseBlock)
    : undefined;
}

/**
 * 0.6.0 PR 9a — the per-candidate plan table honours a pool CANDIDATE's
 * settings; a profile's narrowing knobs on a single-model serving slot have
 * no IR carrier and wait for a later row.
 */
const LANDING_SINGLE_SLOT =
  "a later 0.6.0 row (a single-model serving slot has no per-candidate plan carrier in the IR; the same profile honours it today as a model_pool candidate)";
const LANDING_PREROUTE = "PR 9b (the preRoute decision phase)";
const LANDING_STRATEGIES = "PR 9c/9d (cascade and the guide / shadow / committee side-calls)";
const LANDING_MODEL_DIRECTED =
  "a later 0.6.0 row (the emitters' boot-time wireModels call — emitted bundles do not import @crewhaus/model-service, which depends on runtime-core)";
const LANDING_ROUTER_STORE = "PR 10 (scoped arms, priors and the reward store)";
const LANDING_JUDGE_PANEL = "the §6.2 judge-panel wiring (createJudgeGrader in every judge site)";
const LANDING_AUX_PARAMS =
  "the §4.2 per-slot params consumers (the judge / compaction / degrade / security / watchme request builders)";

function runtimePending(path: string, landing: string, hint?: string): CompilerError {
  return new CompilerError(
    `${path} is accepted by the spec and lowered into the IR, but this runtime does not enforce it yet — it lands with 0.6.0 ${landing}; remove it from the spec for now${hint !== undefined ? ` (${hint})` : ""}`,
  );
}

function assertRoutedBlockLowerable(path: string, block: LooseBlock): void {
  // 0.6.0 PR 9a — a pool candidate's narrowing knobs (`tools` / `tool_config`
  // / `permissions` / `rate_limits` / `cost`) are honoured by runtime-core's
  // per-candidate plan table and compile through; only the PR 9c keys below
  // stay refused on a routed block.
  const judge = asLooseBlock(block["judge"]);
  if (judge?.["escalate_to"] !== undefined) {
    throw runtimePending(
      `${path}.judge.escalate_to`,
      "PR 9c (the forced re-run of a failed gate on the escalation rung)",
      "until then a retry_previous re-run keeps the gated block's own routing",
    );
  }
  const subAgents = asLooseBlock(block["sub_agents"]);
  if (subAgents !== undefined) {
    for (const [name, raw] of Object.entries(subAgents)) {
      const def = asLooseBlock(raw);
      if (def !== undefined) assertRoutedBlockLowerable(`${path}.sub_agents.${name}`, def);
    }
  }
}

/**
 * Throw a path-precise `CompilerError` on the FIRST runtime-pending narrowing
 * key the spec declares; return silently otherwise. Runs once from `lower()`
 * unless `allowRuntimePendingKeys` is set.
 */
function assertNoRuntimePendingKeys(spec: Spec): void {
  const s = spec as unknown as LooseBlock;
  const mcpServers = asLooseBlock(s["mcp_servers"]);
  if (mcpServers !== undefined) {
    for (const [name, raw] of Object.entries(mcpServers)) {
      if (asLooseBlock(raw)?.["tool_flags"] !== undefined) {
        throw new CompilerError(
          `mcp_servers.${name}.tool_flags is accepted by the spec but not yet lowered by this compiler — its IR and emit wiring (registerMcpServer flags) has no 0.6.0 PR-train row yet; remove it from the spec for now`,
        );
      }
    }
  }
  const evaluation = asLooseBlock(s["evaluation"]);
  if (evaluation?.["on_fail"] === "escalate") {
    throw runtimePending(
      "evaluation.on_fail: escalate",
      "PR 9c (the cascade re-run on the escalation rung)",
      "use retry | halt | note",
    );
  }
  const agent = asLooseBlock(s["agent"]);
  if (agent !== undefined) assertRoutedBlockLowerable("agent", agent);
  if (Array.isArray(s["steps"])) {
    for (const [i, raw] of s["steps"].entries()) {
      const step = asLooseBlock(raw);
      if (step !== undefined) assertRoutedBlockLowerable(`steps[${i}]`, step);
    }
  }
  for (const key of ["nodes", "roles"] as const) {
    const map = asLooseBlock(s[key]);
    if (map === undefined) continue;
    for (const [name, raw] of Object.entries(map)) {
      const block = asLooseBlock(raw);
      if (block !== undefined) assertRoutedBlockLowerable(`${key}.${name}`, block);
    }
  }
}

/** The `$<profile>` reference form every model slot accepts (0.6.0 §4.1). */
function profileRefName(value: string): string | undefined {
  return value.startsWith("$") ? value.slice(1) : undefined;
}

/** Nearest declared name within 3 edits — the did-you-mean helper. */
function nearestName(target: string, declared: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of declared) {
    const d = levenshtein(target, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/**
 * Everything `lower()` needs to resolve a model slot: the lowered `models:`
 * registry, the primary model the sentinels rank against, the roster
 * `strongest` searches first, the calendar date for the sunset check, and the
 * warnings sink. Built once per `lower()` by {@link createLowerContext}.
 */
type LowerContext = {
  readonly target: Spec["target"];
  readonly registry: IrModelProfiles;
  readonly hasRegistry: boolean;
  /**
   * 0.6.0 §6.2 / §14 — TRUE when the spec opted into the hybrid surface (a
   * `models:` registry or a pool `strategy`); gates the judge-default flip
   * and the judge-independence lint.
   */
  readonly optedIn: boolean;
  /** The primary grammar string (never a `$ref`, never a sentinel) — `undefined` on a spec without one. */
  readonly primary: string | undefined;
  readonly roster: readonly RosterMember[];
  readonly today: string;
  readonly allowPending: boolean;
  readonly warnings: CompileWarning[];
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function warn(ctx: LowerContext, code: string, path: string, message: string): void {
  ctx.warnings.push({ code, path, message });
}

/** The raw (spec-side) registry a spec declares, `{}` when absent. */
function specRegistry(spec: Spec): Readonly<Record<string, SpecModelProfile>> {
  return (spec as { readonly models?: SpecModelsBlock }).models ?? {};
}

/**
 * The PRIMARY model every sentinel ranks against: `agent.model` on the
 * agent-carrying shapes, the top-level `model` on workflow/graph/crew,
 * followed through a `$ref` to the profile's own grammar string. `undefined`
 * when the spec has none, or when the primary is itself a sentinel — a
 * sentinel cannot be the answer to its own question.
 */
function resolvePrimaryModel(spec: Spec): string | undefined {
  const specLike = spec as { agent?: { model?: unknown }; model?: unknown };
  const raw = specLike.agent?.model ?? specLike.model;
  if (typeof raw !== "string") return undefined;
  const name = profileRefName(raw);
  const resolved = name !== undefined ? specRegistry(spec)[name]?.model : raw;
  if (resolved === undefined || resolved === CHEAPEST_SENTINEL || resolved === STRONGEST_SENTINEL) {
    return undefined;
  }
  return resolved;
}

/**
 * The roster `strongest` searches before falling back to price rank (§4.3):
 * every `models:` profile in declaration order, then every `model_pool`
 * candidate anywhere in the spec (agent / steps / nodes / roles / sub-agents),
 * each with its effective routing tags. Candidates spelled as `$refs` carry
 * the profile's model and inherit its tags when they declare none.
 */
function collectRoster(spec: Spec, registry: IrModelProfiles): RosterMember[] {
  const roster: RosterMember[] = [];
  for (const [name, profile] of Object.entries(registry)) {
    roster.push({
      name,
      model: profile.model,
      ...(profile.tags !== undefined ? { tags: profile.tags } : {}),
    });
  }
  const visitPool = (pool: unknown): void => {
    const candidates = asLooseBlock(pool)?.["candidates"];
    if (!Array.isArray(candidates)) return;
    for (const raw of candidates) {
      const c = asLooseBlock(raw);
      if (c === undefined || typeof c["model"] !== "string") continue;
      const name = profileRefName(c["model"]);
      // A `$ref` candidate carries the LOWERED profile's model (its own
      // sentinel already ranked); a raw member's own sentinel is skipped by
      // `resolveStrongestFromRoster`.
      const model = name !== undefined ? registry[name]?.model : c["model"];
      if (model === undefined) continue;
      const localTags = Array.isArray(c["tags"]) ? (c["tags"] as string[]) : [];
      const tags = localTags.length > 0 ? localTags : (registry[name ?? ""]?.tags ?? []);
      roster.push({ model, tags });
    }
  };
  const visitBlock = (block: unknown): void => {
    const b = asLooseBlock(block);
    if (b === undefined) return;
    visitPool(b["model_pool"]);
    const subAgents = asLooseBlock(b["sub_agents"]);
    if (subAgents !== undefined) for (const def of Object.values(subAgents)) visitBlock(def);
  };
  const s = spec as unknown as LooseBlock;
  visitBlock(s["agent"]);
  if (Array.isArray(s["steps"])) for (const step of s["steps"]) visitBlock(step);
  for (const key of ["nodes", "roles"] as const) {
    const map = asLooseBlock(s[key]);
    if (map !== undefined) for (const block of Object.values(map)) visitBlock(block);
  }
  return roster;
}

/** One slot's resolution: the concrete model plus, for a `$ref`, its profile. */
type ResolvedModelRef = {
  readonly model: string;
  readonly profile?: string;
  readonly settings?: IrModelProfile;
};

/**
 * 0.6.0 §4.3 — `resolveModelRef`: the ONE resolver every model slot goes
 * through (the six that bypassed `resolveAuxModel` included). A `$ref`
 * yields the registry profile's model and settings; `cheapest` keeps its
 * item-25 same-provider price rank against the primary; `strongest`
 * resolves roster-first (profiles, then candidates — first `strong`-tagged,
 * else last declared), and by price rank only for a bare single-model spec.
 * `inRoster` is the circularity rule: inside a profile's own `model:` or a
 * candidate's `model:`, the sentinels rank against the primary only. A
 * grammar string passes through verbatim.
 */
function resolveModelRef(
  value: string,
  ctx: LowerContext,
  slotLabel: string,
  opts: { readonly inRoster?: boolean } = {},
): ResolvedModelRef {
  const name = profileRefName(value);
  if (name !== undefined) {
    if (!SPEC_PROFILE_NAME_RE.test(name)) {
      throw new CompilerError(
        `${slotLabel}: "${value}" is not a valid profile reference — profile names match /^[a-z][a-z0-9_-]{0,63}$/`,
      );
    }
    const settings = ctx.registry[name];
    if (settings === undefined) {
      const declared = Object.keys(ctx.registry);
      const nearest = nearestName(name, declared);
      const hint =
        declared.length === 0
          ? "this spec declares no models: block"
          : nearest !== undefined
            ? `did you mean "$${nearest}"? declared: ${declared.map((d) => `$${d}`).join(", ")}`
            : `declared: ${declared.map((d) => `$${d}`).join(", ")}`;
      throw new CompilerError(`${slotLabel}: unknown profile "${value}" — ${hint}`);
    }
    return { model: settings.model, profile: name, settings };
  }
  if (value === CHEAPEST_SENTINEL) {
    if (ctx.primary === undefined) {
      throw new CompilerError(
        `${slotLabel}: "cheapest" needs a primary agent.model to resolve against, but this spec has none (or its primary is itself a sentinel)`,
      );
    }
    const resolved = resolveCheapestForSlot(ctx.primary);
    if (resolved === undefined) {
      throw new CompilerError(
        `${slotLabel}: "cheapest" cannot be resolved for primary model "${ctx.primary}" — its provider is not in the pricing table (local/azure/named-host). Name a concrete model instead.`,
      );
    }
    return { model: resolved };
  }
  if (value === STRONGEST_SENTINEL) {
    const resolved = resolveStrongestForSlot(ctx.primary ?? "", {
      ...(opts.inRoster === true ? { inRoster: true } : { roster: ctx.roster }),
    });
    if (resolved === undefined) {
      throw new CompilerError(
        ctx.primary === undefined
          ? `${slotLabel}: "strongest" needs a models: profile or model_pool roster, or a primary agent.model to rank against — this spec has neither`
          : `${slotLabel}: "strongest" cannot be resolved for primary model "${ctx.primary}" — declare a models: profile or model_pool candidate to pick from, or name a concrete model (its provider is not in the pricing table)`,
      );
    }
    if (ctx.primary !== undefined && crossesProvider(ctx.primary, resolved.modelString)) {
      warn(
        ctx,
        "model-strongest-crosses-provider",
        slotLabel,
        `${slotLabel}: "strongest" resolved to "${resolved.modelString}" (${resolved.source}), a different provider from the primary "${ctx.primary}" — transcript content leaves the primary's box and a second credential is needed`,
      );
    }
    const settings = resolved.profile !== undefined ? ctx.registry[resolved.profile] : undefined;
    return {
      model: resolved.modelString,
      ...(resolved.profile !== undefined ? { profile: resolved.profile } : {}),
      ...(settings !== undefined ? { settings } : {}),
    };
  }
  return { model: value };
}

/** The spec-side shape a `models:` profile and an inline pool candidate share. */
type SpecProfileFields = {
  readonly tags?: readonly string[];
  readonly max_tokens?: number;
  readonly thinking?: SpecThinking;
  readonly temperature?: number;
  readonly instructions?: string;
  readonly tools?: readonly string[];
  readonly tool_config?: Record<string, unknown>;
  readonly permissions?: { readonly deny?: readonly string[]; readonly ask?: readonly string[] };
  readonly rate_limits?: SpecRateLimits;
  readonly limits?: { readonly model_call_timeout_ms?: number };
  readonly caching?: "prefer" | "off";
  readonly cost?: { readonly max_usd: number };
  readonly requires?: {
    readonly tool_use?: boolean;
    readonly vision?: boolean;
    readonly thinking?: boolean;
    readonly web_search?: boolean;
    readonly context_window_gte?: number;
    readonly max_output_tokens_gte?: number;
  };
  readonly capabilities?: {
    readonly tool_use?: boolean;
    readonly vision?: boolean;
    readonly thinking?: boolean;
    readonly web_search?: boolean;
    readonly caching?: "explicit" | "automatic" | false;
    readonly context_window?: number;
    readonly max_output_tokens?: number;
  };
  readonly fallbacks?: readonly string[];
  readonly circuit_breaker?: {
    readonly failureThreshold?: number;
    readonly windowMs?: number;
    readonly cooldownMs?: number;
  };
};

function lowerCircuitBreaker(
  cb: NonNullable<SpecProfileFields["circuit_breaker"]>,
): IrCircuitBreaker {
  return {
    ...(cb.failureThreshold !== undefined ? { failureThreshold: cb.failureThreshold } : {}),
    ...(cb.windowMs !== undefined ? { windowMs: cb.windowMs } : {}),
    ...(cb.cooldownMs !== undefined ? { cooldownMs: cb.cooldownMs } : {}),
  };
}

/** §5.4 — the restricted `{deny, ask}` profile permissions, carried verbatim. */
function lowerProfilePermissions(
  p: NonNullable<SpecProfileFields["permissions"]>,
): IrProfilePermissions {
  return {
    ...(p.deny !== undefined ? { deny: [...p.deny] } : {}),
    ...(p.ask !== undefined ? { ask: [...p.ask] } : {}),
  };
}

function lowerRequires(r: NonNullable<SpecProfileFields["requires"]>): IrModelRequires {
  return {
    ...(r.tool_use !== undefined ? { tool_use: r.tool_use } : {}),
    ...(r.vision !== undefined ? { vision: r.vision } : {}),
    ...(r.thinking !== undefined ? { thinking: r.thinking } : {}),
    ...(r.web_search !== undefined ? { web_search: r.web_search } : {}),
    ...(r.context_window_gte !== undefined ? { contextWindowGte: r.context_window_gte } : {}),
    ...(r.max_output_tokens_gte !== undefined
      ? { maxOutputTokensGte: r.max_output_tokens_gte }
      : {}),
  };
}

function lowerCapabilities(c: NonNullable<SpecProfileFields["capabilities"]>): IrModelCapabilities {
  return {
    ...(c.tool_use !== undefined ? { tool_use: c.tool_use } : {}),
    ...(c.vision !== undefined ? { vision: c.vision } : {}),
    ...(c.thinking !== undefined ? { thinking: c.thinking } : {}),
    ...(c.web_search !== undefined ? { web_search: c.web_search } : {}),
    ...(c.caching !== undefined ? { caching: c.caching } : {}),
    ...(c.context_window !== undefined ? { contextWindow: c.context_window } : {}),
    ...(c.max_output_tokens !== undefined ? { maxOutputTokens: c.max_output_tokens } : {}),
  };
}

/** Every profile field except `model` / `tags` / `profile`, in the IR's canonical key order. */
type LoweredProfileFields = Omit<IrModelProfile, "model" | "tags" | "profile">;

/**
 * Lower the per-model settings a profile or candidate declares — snake_case
 * spec keys to camelCase IR keys, `cost.max_usd` to USD micros, `fallbacks`
 * resolved through the registry (a candidate may name `$refs`; a profile's
 * are grammar strings by cross-field rule). Declared-fields-only, so a body
 * that declares nothing lowers to `{}`.
 */
function lowerProfileFields(
  body: SpecProfileFields,
  ctx: LowerContext,
  path: string,
): LoweredProfileFields {
  return {
    ...lowerThinking(body.thinking),
    ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.limits?.model_call_timeout_ms !== undefined
      ? { modelCallTimeoutMs: body.limits.model_call_timeout_ms }
      : {}),
    ...(body.instructions !== undefined ? { overlay: body.instructions } : {}),
    ...(body.tools !== undefined ? { tools: [...body.tools] } : {}),
    ...(body.tool_config !== undefined ? { toolConfigs: lowerToolConfigs(body.tool_config) } : {}),
    ...(body.permissions !== undefined
      ? { permissions: lowerProfilePermissions(body.permissions) }
      : {}),
    ...lowerRateLimits(body.rate_limits),
    ...(body.caching !== undefined ? { caching: body.caching } : {}),
    ...(body.cost !== undefined
      ? { costCapUsdMicros: Math.round(body.cost.max_usd * 1_000_000) }
      : {}),
    ...(body.requires !== undefined ? { requires: lowerRequires(body.requires) } : {}),
    ...(body.capabilities !== undefined
      ? { capabilities: lowerCapabilities(body.capabilities) }
      : {}),
    ...(body.fallbacks !== undefined
      ? {
          fallbacks: body.fallbacks.map(
            (f, i) => resolveModelRef(f, ctx, `${path}.fallbacks[${i}]`, { inRoster: true }).model,
          ),
        }
      : {}),
    ...(body.circuit_breaker !== undefined
      ? { circuitBreaker: lowerCircuitBreaker(body.circuit_breaker) }
      : {}),
  };
}

/**
 * The offline capability view of one roster member: the table row for a
 * table-backed model with the declared `capabilities:` override merged over
 * it, or the declared override alone (unknown flags read as `false` — never
 * over-promise), or `undefined` when neither exists.
 */
function memberCapabilities(member: IrModelProfile): ModelCapabilities | undefined {
  const parsed = providerOfSpecString(member.model);
  const table =
    parsed !== undefined
      ? resolveCapabilities(DEFAULT_CAPABILITIES, parsed.provider, parsed.modelId)
      : undefined;
  const declared = member.capabilities;
  if (table === undefined && declared === undefined) return undefined;
  const base: ModelCapabilities = table ?? {
    caching: false,
    tool_use: false,
    vision: false,
    thinking: false,
    web_search: false,
  };
  if (declared === undefined) return base;
  return {
    caching: declared.caching ?? base.caching,
    tool_use: declared.tool_use ?? base.tool_use,
    vision: declared.vision ?? base.vision,
    thinking: declared.thinking ?? base.thinking,
    web_search: declared.web_search ?? base.web_search,
    ...((declared.contextWindow ?? base.contextWindow) !== undefined
      ? { contextWindow: declared.contextWindow ?? base.contextWindow }
      : {}),
    ...((declared.maxOutputTokens ?? base.maxOutputTokens) !== undefined
      ? { maxOutputTokens: declared.maxOutputTokens ?? base.maxOutputTokens }
      : {}),
  };
}

/**
 * 0.6.0 §4.3 — compile-time capability + sunset validation of one roster
 * member (a `models:` profile or a pool candidate). For a model the offline
 * table knows (or one with a declared `capabilities:` override):
 *   - `requires` must be satisfied (`satisfiesCapabilities`, the same twin
 *     `enumerateCandidates` uses) — a CompilerError names the unmet key;
 *   - a declared `thinking` on a model that cannot think, or a non-empty
 *     `tools` on a model without tool use, is a CompilerError;
 * A model neither table nor override describes gets ONE warning that
 * `adapter.features` is the only gate. A `KNOWN_SUNSETS` family warns with
 * its replacement; past `retiresOn` a `models:` profile (new 0.6.0 surface,
 * so no deployed spec can be broken) is a CompilerError, while a bare pool
 * candidate keeps the warning — a wall-clock error on a pre-0.6.0 surface
 * would break a spec that compiled yesterday.
 */
function validateModelMember(
  member: IrModelProfile,
  ctx: LowerContext,
  path: string,
  kind: "profile" | "candidate",
): void {
  const caps = memberCapabilities(member);
  if (caps === undefined) {
    if (
      member.requires !== undefined ||
      member.thinking !== undefined ||
      (member.tools !== undefined && member.tools.length > 0)
    ) {
      warn(
        ctx,
        "model-capabilities-unknown",
        path,
        `${path}: model "${member.model}" is not in the offline capability table and declares no capabilities: — its requires / thinking / tools cannot be validated at compile time, so adapter.features is the only gate`,
      );
    }
  } else {
    const req = member.requires;
    if (req !== undefined && !satisfiesCapabilities(caps, req)) {
      const unmet = (
        [
          ["tool_use", req.tool_use === true && !caps.tool_use],
          ["vision", req.vision === true && !caps.vision],
          ["thinking", req.thinking === true && !caps.thinking],
          ["web_search", req.web_search === true && !caps.web_search],
          [
            "context_window_gte",
            req.contextWindowGte !== undefined &&
              (caps.contextWindow === undefined || caps.contextWindow < req.contextWindowGte),
          ],
          [
            "max_output_tokens_gte",
            req.maxOutputTokensGte !== undefined &&
              (caps.maxOutputTokens === undefined || caps.maxOutputTokens < req.maxOutputTokensGte),
          ],
        ] as const
      )
        .filter(([, failed]) => failed)
        .map(([key]) => key);
      throw new CompilerError(
        `${path}: model "${member.model}" cannot satisfy requires.${unmet.join(", requires.")} — the capability table says the model lacks it; pick a model that has it or drop the requirement`,
      );
    }
    if (member.thinking !== undefined && !caps.thinking) {
      throw new CompilerError(
        `${path}: declares thinking, but model "${member.model}" does not support extended thinking (capability table) — drop thinking or pick a thinking-capable model`,
      );
    }
    if (member.tools !== undefined && member.tools.length > 0 && !caps.tool_use) {
      throw new CompilerError(
        `${path}: declares tools, but model "${member.model}" does not support tool use (capability table) — use tools: [] or pick a tool-capable model`,
      );
    }
  }
  const parsed = providerOfSpecString(member.model);
  if (parsed !== undefined) {
    const sunset = findSunset(parsed.provider, parsed.modelId);
    if (sunset !== undefined) {
      const retired = ctx.today >= sunset.retiresOn;
      const message = `${path}: model "${member.model}" ${retired ? "was retired on" : "is scheduled for retirement on"} ${sunset.retiresOn} — migrate to ${sunset.replacement}${sunset.note !== undefined ? ` (${sunset.note})` : ""}`;
      if (retired && kind === "profile") throw new CompilerError(message);
      warn(ctx, "model-sunset", path, message);
    }
  }
}

/**
 * Lower one `models:` profile: the sentinel in its own `model:` resolves by
 * price rank against the primary (the circularity rule — a roster member
 * cannot be defined in terms of the roster), every other field through
 * {@link lowerProfileFields}, then the member is validated.
 */
function lowerProfile(name: string, profile: SpecModelProfile, ctx: LowerContext): IrModelProfile {
  const path = `models.${name}`;
  const model = resolveModelRef(profile.model, ctx, `${path}.model`, { inRoster: true }).model;
  const lowered: IrModelProfile = {
    profile: name,
    model,
    ...(profile.tags !== undefined ? { tags: [...profile.tags] } : {}),
    ...lowerProfileFields(profile, ctx, path),
  };
  validateModelMember(lowered, ctx, path, "profile");
  return lowered;
}

function createLowerContext(spec: Spec, opts: LowerOptions): LowerContext {
  const rawRegistry = specRegistry(spec);
  const hasRegistry = (spec as { readonly models?: SpecModelsBlock }).models !== undefined;
  const warnings: CompileWarning[] = [];
  // Profiles lower in two phases: first a registry with only `model`
  // resolved (so a profile's fallbacks can be checked and `strongest` has a
  // roster), then the full field lowering + validation.
  const primary = resolvePrimaryModel(spec);
  const base: LowerContext = {
    target: spec.target,
    registry: {},
    hasRegistry,
    optedIn: hasRegistry || specDeclaresStrategy(spec),
    primary,
    roster: [],
    today: opts.today ?? todayIso(),
    allowPending: opts.allowRuntimePendingKeys === true,
    warnings,
  };
  const registry: Record<string, IrModelProfile> = {};
  for (const [name, profile] of Object.entries(rawRegistry)) {
    registry[name] = lowerProfile(name, profile, base);
  }
  const frozen: IrModelProfiles = Object.freeze(registry);
  return {
    ...base,
    registry: frozen,
    roster: collectRoster(spec, frozen),
  };
}

/**
 * How a single-model slot honours a referenced profile — the per-shape
 * contract of §11.3, spelled per slot kind:
 *   - `agent-full`        — cli/channel/managed agent, workflow step, graph
 *                           node, crew role, sub-agent: model, thinking,
 *                           maxTokens, temperature, overlay, and (when the
 *                           slot declares no routing block of its own) the
 *                           profile's fallbacks + circuit breaker;
 *   - `agent-params`      — research/batch/browser agent: model, maxTokens,
 *                           temperature, overlay (no thinking / failover home);
 *   - `agent-temperature` — pipeline agent: model, temperature, overlay;
 *   - `agent-model`       — voice/eval/onchain/onchain-game: model, overlay;
 *   - `aux`               — judge / compaction / degrade / security / watchme /
 *                           grounding: model plus the pinned request params;
 *   - `model-only`        — tiers, fallback entries, strategy model slots.
 */
type SingleSlotKind =
  | "agent-full"
  | "agent-params"
  | "agent-temperature"
  | "agent-model"
  | "aux"
  | "model-only";

type SingleSlotLocal = {
  readonly thinking?: IrThinking;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** The slot declares its own `model_pool` / `model_tiers` / `model_fallbacks`. */
  readonly hasRouting?: boolean;
};

type SingleSlotResult = {
  readonly model: string;
  readonly modelProfile?: string;
  readonly thinking?: IrThinking;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** The profile's overlay, for the caller to fold into `instructions`. */
  readonly overlay?: string;
  readonly modelFallbacks?: readonly string[];
  readonly circuitBreaker?: IrCircuitBreaker;
  /** `aux` slots: the profile's pinned params for the consumer's own request. */
  readonly params?: IrModelParams;
};

const SHAPE_REASON: Readonly<Partial<Record<Spec["target"], string>>> = {
  voice: "the realtime voice loop registers no tool catalog and takes no request params",
  eval: "the eval bundle runs the agent through the eval-runner's own request path",
  onchain: "the onchain daemon's agent-loop wiring takes no request params",
  "onchain-game": "the onchain-game daemon's agent-loop wiring takes no request params",
  pipeline: "the pipeline agent block carries no thinking or max_tokens",
  research: "the research agent block carries no thinking or failover chain",
  batch: "the batch agent block carries no thinking or failover chain",
  browser: "the browser agent block carries no thinking or failover chain",
};

/**
 * Apply a resolved `$profile` (or a bare model) to a single-model slot per
 * {@link SingleSlotKind}. Slot-local params override the profile's
 * field-by-field; because `temperature` and `thinking` are exclusive on one
 * request, a slot that declares one of the pair drops the profile's other.
 * Every profile field the slot cannot honour is reported field-precisely
 * (see the section header); the narrowing knobs on a serving slot are
 * REFUSED until PR 9a unless `allowRuntimePendingKeys` is set.
 */
function applyProfileToSlot(
  ref: ResolvedModelRef,
  ctx: LowerContext,
  slotPath: string,
  kind: SingleSlotKind,
  local: SingleSlotLocal = {},
): SingleSlotResult {
  const settings = ref.settings;
  const provenance = ref.profile !== undefined ? { modelProfile: ref.profile } : {};
  if (settings === undefined) {
    return {
      model: ref.model,
      ...provenance,
      ...(local.thinking !== undefined ? { thinking: local.thinking } : {}),
      ...(local.maxTokens !== undefined ? { maxTokens: local.maxTokens } : {}),
      ...(local.temperature !== undefined ? { temperature: local.temperature } : {}),
    };
  }
  const name = ref.profile ?? "?";
  const at = `models.${name}`;
  const ignoredOnShape = (field: string): void =>
    warn(
      ctx,
      "model-plan-ignored-on-shape",
      `${at}.${field}`,
      `${at}.${field} (referenced from ${slotPath}) is ignored on the ${ctx.target} shape — ${SHAPE_REASON[ctx.target] ?? "this shape has no home for it"}`,
    );
  const ignoredOnSlot = (field: string, why: string): void =>
    warn(
      ctx,
      "model-plan-ignored-on-slot",
      `${at}.${field}`,
      `${at}.${field} (referenced from ${slotPath}) has no meaning on this slot — ${why}; it is ignored`,
    );
  const pending = (field: string, landing: string): void =>
    warn(
      ctx,
      "model-plan-pending-runtime",
      `${at}.${field}`,
      `${at}.${field} (referenced from ${slotPath}) is lowered but the runtime does not honour it yet — it lands with 0.6.0 ${landing}; until then it is inert`,
    );
  const isAgent = kind !== "aux" && kind !== "model-only";
  const honoursThinking = kind === "agent-full";
  const honoursMaxTokens = kind === "agent-full" || kind === "agent-params";
  const honoursTemperature = isAgent && kind !== "agent-model";
  const honoursFailover = kind === "agent-full";

  // Exclusivity: a slot-local pin drops the profile's other half of the pair.
  const profileThinking = local.temperature !== undefined ? undefined : settings.thinking;
  const profileTemperature = local.thinking !== undefined ? undefined : settings.temperature;

  const params: { -readonly [K in keyof IrModelParams]: IrModelParams[K] } = {};
  const out: { -readonly [K in keyof SingleSlotResult]: SingleSlotResult[K] } = {
    model: ref.model,
    ...provenance,
  };

  const thinking = local.thinking ?? profileThinking;
  if (thinking !== undefined) {
    if (honoursThinking || local.thinking !== undefined) out.thinking = thinking;
    else if (kind === "aux") params.thinking = thinking;
    else if (isAgent) ignoredOnShape("thinking");
    else ignoredOnSlot("thinking", "request params apply to serving and auxiliary slots");
  }
  const maxTokens = local.maxTokens ?? settings.maxTokens;
  if (maxTokens !== undefined) {
    if (honoursMaxTokens || local.maxTokens !== undefined) out.maxTokens = maxTokens;
    else if (kind === "aux") params.maxTokens = maxTokens;
    else if (isAgent) ignoredOnShape("max_tokens");
    else ignoredOnSlot("max_tokens", "request params apply to serving and auxiliary slots");
  }
  const temperature = local.temperature ?? profileTemperature;
  if (temperature !== undefined) {
    if (honoursTemperature || local.temperature !== undefined) out.temperature = temperature;
    else if (kind === "aux") params.temperature = temperature;
    else if (isAgent) ignoredOnShape("temperature");
    else ignoredOnSlot("temperature", "request params apply to serving and auxiliary slots");
  }
  if (settings.overlay !== undefined) {
    if (isAgent) out.overlay = settings.overlay;
    else ignoredOnSlot("instructions", "an overlay is appended to a serving agent's prompt");
  }
  if (settings.fallbacks !== undefined || settings.circuitBreaker !== undefined) {
    if (honoursFailover && local.hasRouting !== true) {
      if (settings.fallbacks !== undefined) out.modelFallbacks = settings.fallbacks;
      if (settings.circuitBreaker !== undefined) out.circuitBreaker = settings.circuitBreaker;
    } else {
      for (const field of ["fallbacks", "circuit_breaker"] as const) {
        const present = field === "fallbacks" ? settings.fallbacks : settings.circuitBreaker;
        if (present === undefined) continue;
        if (honoursFailover) {
          ignoredOnSlot(
            field,
            "the slot declares its own model_pool / model_tiers / model_fallbacks",
          );
        } else if (isAgent) {
          ignoredOnShape(field);
        } else {
          ignoredOnSlot(field, "a failover chain applies to a serving slot or a pool candidate");
        }
      }
    }
  }
  if (settings.modelCallTimeoutMs !== undefined) {
    if (isAgent) pending("limits.model_call_timeout_ms", LANDING_SINGLE_SLOT);
    else
      ignoredOnSlot("limits.model_call_timeout_ms", "the per-call timer applies to a serving slot");
  }
  if (settings.caching !== undefined) {
    if (isAgent) pending("caching", LANDING_SINGLE_SLOT);
    else ignoredOnSlot("caching", "prompt-cache markers apply to a serving slot");
  }
  // The narrowing knobs: refused on a SINGLE-MODEL serving slot (no IR
  // carrier — a pool candidate honours them, see the section header);
  // meaningless on an auxiliary / model-only slot (a judge profile's
  // `tools: []` is the documented no-op and stays silent).
  const narrowing: ReadonlyArray<readonly [string, unknown]> = [
    ["tools", settings.tools],
    ["tool_config", settings.toolConfigs],
    ["permissions", settings.permissions],
    ["rate_limits", settings.rateLimits],
    ["cost", settings.costCapUsdMicros],
  ];
  // A shape with a tool catalog (agent-full / agent-params) refuses them on
  // a single-model slot; a shape that can NEVER honour them (voice / eval /
  // onchain / pipeline) reports them ignored-on-shape, permanently.
  const narrowingRefused = kind === "agent-full" || kind === "agent-params";
  for (const [field, value] of narrowing) {
    if (value === undefined) continue;
    if (isAgent && !narrowingRefused) {
      ignoredOnShape(field);
      continue;
    }
    if (isAgent) {
      if (!ctx.allowPending) {
        throw runtimePending(
          `${at}.${field} (referenced from ${slotPath})`,
          LANDING_SINGLE_SLOT,
          "a profile declared narrower than the shape would serve with the shape's full toolset and permissions on a single-model slot — declare the profile as a model_pool candidate (which honours it), or declare the narrowing on the shape",
        );
      }
      pending(field, LANDING_SINGLE_SLOT);
      continue;
    }
    if (field === "tools" && Array.isArray(value) && value.length === 0) continue;
    ignoredOnSlot(
      field,
      "per-model tools, tool settings, permissions, rate limits and spend caps apply to serving slots",
    );
  }
  if (Object.keys(params).length > 0) out.params = params;
  return out;
}

/** Fold a profile overlay into a slot's instructions — overlay first, blank-line separated (§4.2). */
function foldOverlay(instructions: string, overlay: string | undefined): string {
  return overlay === undefined ? instructions : `${overlay}\n\n${instructions}`;
}

/** The IR fields a serving single-model slot gains from {@link applyProfileToSlot}. */
function servingSlotFields(r: SingleSlotResult): {
  modelProfile?: string;
  maxTokens?: number;
  thinking?: IrThinking;
  temperature?: number;
} {
  return {
    ...(r.modelProfile !== undefined ? { modelProfile: r.modelProfile } : {}),
    ...(r.maxTokens !== undefined ? { maxTokens: r.maxTokens } : {}),
    ...(r.thinking !== undefined ? { thinking: r.thinking } : {}),
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
  };
}

/** The failover fields a serving slot inherits from its profile (absent when it routes itself). */
function servingSlotFailover(r: SingleSlotResult): {
  modelFallbacks?: readonly string[];
  circuitBreaker?: IrCircuitBreaker;
} {
  return {
    ...(r.modelFallbacks !== undefined ? { modelFallbacks: r.modelFallbacks } : {}),
    ...(r.circuitBreaker !== undefined ? { circuitBreaker: r.circuitBreaker } : {}),
  };
}

/** The `aux`-slot provenance + params spread every auxiliary consumer shares. */
function auxSlotFields(r: SingleSlotResult): { modelProfile?: string; params?: IrModelParams } {
  return {
    ...(r.modelProfile !== undefined ? { modelProfile: r.modelProfile } : {}),
    ...(r.params !== undefined ? { params: r.params } : {}),
  };
}

/** Resolve an auxiliary model slot (judge / compaction / degrade / security / watchme / grounding). */
function resolveAuxSlot(value: string, ctx: LowerContext, slotLabel: string): SingleSlotResult {
  const r = applyProfileToSlot(resolveModelRef(value, ctx, slotLabel), ctx, slotLabel, "aux");
  if (r.params !== undefined) {
    warn(
      ctx,
      "model-plan-pending-runtime",
      slotLabel,
      `${slotLabel}: the profile's pinned request params are lowered but this consumer does not read them yet — they land with 0.6.0 ${LANDING_AUX_PARAMS}; until then they are inert`,
    );
  }
  return r;
}

/**
 * 0.6.0 §6.2 — the GATED judge-default flip. On a spec that opted into the
 * hybrid surface (a `models:` registry or a pool `strategy`), an in-loop
 * judge or judge gate that names no model defaults to `strongest`
 * (roster-first, so it lands on the strong profile or candidate) instead of
 * the serving model; a 0.5.x-shaped spec keeps the serving-model default
 * (the emitters' `grader.model ?? agent.model`), so its bundle stays
 * byte-identical (§14). Implemented here rather than in the three
 * `renderEvaluation` copies so the interpreter reads the same IR. Returns
 * `undefined` when the spec did not opt in, or when `strongest` has nothing
 * to rank against (an empty registry beside a non-table primary) — the
 * serving-model default then stands.
 */
function defaultJudgeSlot(ctx: LowerContext, slotLabel: string): SingleSlotResult | undefined {
  if (!ctx.optedIn) return undefined;
  if (resolveStrongestForSlot(ctx.primary ?? "", { roster: ctx.roster }) === undefined) {
    return undefined;
  }
  return resolveAuxSlot(STRONGEST_SENTINEL, ctx, slotLabel);
}

/** Resolve a model-only slot (tier / fallback / strategy model): the model string plus provenance. */
function resolveModelOnly(
  value: string,
  ctx: LowerContext,
  slotLabel: string,
): { readonly model: string; readonly profile?: string } {
  const r = applyProfileToSlot(
    resolveModelRef(value, ctx, slotLabel),
    ctx,
    slotLabel,
    "model-only",
  );
  return { model: r.model, ...(r.modelProfile !== undefined ? { profile: r.modelProfile } : {}) };
}

/** A strategy / rule / floor ROLE slot: a candidate tag, or a `$profile` lowered to its arm id (the profile name). */
function lowerRoleSlot(value: string): string {
  return profileRefName(value) ?? value;
}

type SpecAgentWithFailover = {
  readonly model_fallbacks?: readonly string[];
  readonly circuit_breaker?: {
    readonly failureThreshold?: number;
    readonly windowMs?: number;
    readonly cooldownMs?: number;
  };
  readonly model_tiers?: {
    readonly fast: string;
    readonly default: string;
    readonly routing?: {
      readonly contextTokenThreshold?: number;
      readonly toolsToDefault?: boolean;
      readonly firstTurnToDefault?: boolean;
      readonly priorToolDensityThreshold?: number;
    };
  };
  /** 0.6.0 — the spec's own pool type: candidates carry every profile field inline. */
  readonly model_pool?: SpecModelPoolBlock;
};

type SpecModelPoolBlockValue = NonNullable<SpecModelPoolBlock>;
type SpecModelPoolCandidateValue = SpecModelPoolBlockValue["candidates"][number];

/**
 * Compile-time pins (0.6.0 PR 7b, §7.7): the lowered pool candidate and rule
 * are structurally `@crewhaus/model-plan`'s `ModelProfile` and `RouteRule`.
 * `@crewhaus/crew-orchestrator` types the emitted role literal's `modelPool`
 * as runtime-core's pool option intersected with those two model-plan types
 * (it deliberately imports no `@crewhaus/ir`), so these two assertions are
 * what make `JSON.stringify(role.modelPool)` typecheck against
 * `RoleDefinition.modelPool` by construction. They live here — not in a test
 * — because test files are excluded from `tsc -b`, and this is the one
 * package that legitimately imports both sides. A drift in either IR type
 * fails this compile.
 */
type AssertTrue<T extends true> = T;
type _IrPoolCandidateIsModelProfile = AssertTrue<
  IrModelPoolCandidate extends ModelProfile ? true : false
>;
type _IrPoolRuleIsRouteRule = AssertTrue<IrModelPoolRule extends RouteRule ? true : false>;

/**
 * 0.6.0 §4.3 — lower one pool candidate. A `$profile` candidate takes the
 * profile as its defaults and overrides field-by-field; its `tags` REPLACE
 * the profile's when it declares any (they are the routing identity, not an
 * accumulation). KEY ORDER IS THE BYTE CONTRACT (design stance 3): `model`
 * then `tags` are inserted first and every 0.6.0 key spreads after them, so
 * `JSON.stringify` of a plain 0.5.x candidate is unchanged.
 */
function lowerPoolCandidate(
  c: SpecModelPoolCandidateValue,
  ctx: LowerContext,
  cpath: string,
): IrModelPoolCandidate {
  const isRef = profileRefName(c.model) !== undefined;
  const ref = resolveModelRef(c.model, ctx, `${cpath}.model`, { inRoster: !isRef });
  const local = lowerProfileFields(c, ctx, cpath);
  const inherited: LoweredProfileFields =
    ref.settings !== undefined ? stripIdentity(ref.settings) : {};
  // Exclusivity across the merge: a local pin of one half drops the profile's other.
  const merged: LoweredProfileFields = {
    ...inherited,
    ...(local.thinking !== undefined ? { temperature: undefined } : {}),
    ...(local.temperature !== undefined ? { thinking: undefined } : {}),
    ...local,
  };
  const tags = c.tags.length > 0 ? [...c.tags] : [...(ref.settings?.tags ?? [])];
  const candidate: IrModelPoolCandidate = {
    model: ref.model,
    tags,
    ...(ref.profile !== undefined ? { profile: ref.profile } : {}),
    ...canonicalProfileFields(merged),
    ...(c.enabled === false ? { enabled: false as const } : {}),
  };
  validateModelMember(candidate, ctx, cpath, "candidate");
  // 0.6.0 PR 9a — every per-candidate setting the plan table honours
  // (`thinking` / `max_tokens` / `temperature` / `limits` / `instructions` /
  // `tools` / `tool_config` / `permissions` / `rate_limits` / `caching` /
  // `cost`) lowers silently: runtime-core builds one CandidatePlan per
  // candidate from this blob at boot. Only the per-candidate failover chain
  // and breaker (PR 10) are still reported pending.
  for (const [irKey, specKey, landing] of [
    ["fallbacks", "fallbacks", LANDING_ROUTER_STORE],
    ["circuitBreaker", "circuit_breaker", LANDING_ROUTER_STORE],
  ] as const) {
    if (candidate[irKey] === undefined) continue;
    warn(
      ctx,
      "model-plan-pending-runtime",
      `${cpath}.${specKey}`,
      `${cpath}.${specKey} is lowered into the pool blob but the runtime does not honour it yet — it lands with 0.6.0 ${landing}; until then the candidate serves on the run's settings`,
    );
  }
  return candidate;
}

/** A profile's settings without its identity (`profile` / `model` / `tags`). */
function stripIdentity(profile: IrModelProfile): LoweredProfileFields {
  const { profile: _profile, model: _model, tags: _tags, ...rest } = profile;
  return rest;
}

/** Re-spell a merged field bag in the IR's canonical key order, dropping `undefined`. */
function canonicalProfileFields(f: LoweredProfileFields): LoweredProfileFields {
  return {
    ...(f.thinking !== undefined ? { thinking: f.thinking } : {}),
    ...(f.maxTokens !== undefined ? { maxTokens: f.maxTokens } : {}),
    ...(f.temperature !== undefined ? { temperature: f.temperature } : {}),
    ...(f.modelCallTimeoutMs !== undefined ? { modelCallTimeoutMs: f.modelCallTimeoutMs } : {}),
    ...(f.overlay !== undefined ? { overlay: f.overlay } : {}),
    ...(f.tools !== undefined ? { tools: f.tools } : {}),
    ...(f.toolConfigs !== undefined ? { toolConfigs: f.toolConfigs } : {}),
    ...(f.permissions !== undefined ? { permissions: f.permissions } : {}),
    ...(f.rateLimits !== undefined ? { rateLimits: f.rateLimits } : {}),
    ...(f.caching !== undefined ? { caching: f.caching } : {}),
    ...(f.costCapUsdMicros !== undefined ? { costCapUsdMicros: f.costCapUsdMicros } : {}),
    ...(f.requires !== undefined ? { requires: f.requires } : {}),
    ...(f.capabilities !== undefined ? { capabilities: f.capabilities } : {}),
    ...(f.fallbacks !== undefined ? { fallbacks: f.fallbacks } : {}),
    ...(f.circuitBreaker !== undefined ? { circuitBreaker: f.circuitBreaker } : {}),
  };
}

function lowerPoolRules(
  rules: NonNullable<SpecModelPoolBlockValue["rules"]>,
): readonly IrModelPoolRule[] {
  return rules.map((rule) => ({
    id: rule.id,
    when: {
      ...(rule.when.has_images !== undefined ? { has_images: rule.when.has_images } : {}),
      ...(rule.when.message_matches !== undefined
        ? { message_matches: rule.when.message_matches }
        : {}),
      ...(rule.when.user_text_chars_gt !== undefined
        ? { user_text_chars_gt: rule.when.user_text_chars_gt }
        : {}),
      ...(rule.when.context_tokens_gt !== undefined
        ? { context_tokens_gt: rule.when.context_tokens_gt }
        : {}),
      ...(rule.when.tool_in_play !== undefined ? { tool_in_play: rule.when.tool_in_play } : {}),
      ...(rule.when.channel !== undefined ? { channel: rule.when.channel } : {}),
      ...(rule.when.budget_spent_ratio_gt !== undefined
        ? { budget_spent_ratio_gt: rule.when.budget_spent_ratio_gt }
        : {}),
      ...(rule.when.turn_index_lt !== undefined ? { turn_index_lt: rule.when.turn_index_lt } : {}),
    },
    use:
      typeof rule.use === "string"
        ? lowerRoleSlot(rule.use)
        : { requires: lowerRequires(rule.use.requires) },
    ...(rule.enabled !== undefined ? { enabled: rule.enabled } : {}),
  }));
}

function lowerPoolClassifier(
  c: NonNullable<SpecModelPoolBlockValue["classifier"]>,
  ctx: LowerContext,
  path: string,
): IrModelPoolClassifier {
  const model = resolveModelOnly(c.model, ctx, `${path}.model`);
  return {
    model: model.model,
    ...(model.profile !== undefined ? { modelProfile: model.profile } : {}),
    labels: { ...c.labels },
    ...(c.max_tokens !== undefined ? { maxTokens: c.max_tokens } : {}),
  };
}

function lowerPoolStrategy(
  st: NonNullable<SpecModelPoolBlockValue["strategy"]>,
  ctx: LowerContext,
  path: string,
): IrModelPoolStrategy {
  const out: { -readonly [K in keyof IrModelPoolStrategy]: IrModelPoolStrategy[K] } = {};
  if (st.cascade !== undefined) {
    out.cascade = {
      draft: lowerRoleSlot(st.cascade.draft),
      escalateTo: lowerRoleSlot(st.cascade.escalate_to),
      ...(st.cascade.clean_prompt !== undefined ? { cleanPrompt: st.cascade.clean_prompt } : {}),
    };
  }
  if (st.guide !== undefined) {
    const model = resolveModelOnly(st.guide.model, ctx, `${path}.guide.model`);
    out.guide = {
      model: model.model,
      ...(model.profile !== undefined ? { modelProfile: model.profile } : {}),
      ...(st.guide.every !== undefined ? { every: st.guide.every } : {}),
      ...(st.guide.max_tokens !== undefined ? { maxTokens: st.guide.max_tokens } : {}),
      ...(st.guide.budget_usd !== undefined ? { budgetUsd: st.guide.budget_usd } : {}),
    };
  }
  if (st.shadow !== undefined) {
    const candidate = resolveModelOnly(st.shadow.candidate, ctx, `${path}.shadow.candidate`);
    const gradeWith =
      st.shadow.grade_with !== undefined
        ? resolveModelOnly(st.shadow.grade_with, ctx, `${path}.shadow.grade_with`)
        : undefined;
    out.shadow = {
      candidate: candidate.model,
      ...(candidate.profile !== undefined ? { candidateProfile: candidate.profile } : {}),
      ...(st.shadow.sample_rate !== undefined ? { sampleRate: st.shadow.sample_rate } : {}),
      ...(gradeWith !== undefined ? { gradeWith: gradeWith.model } : {}),
      ...(gradeWith?.profile !== undefined ? { gradeWithProfile: gradeWith.profile } : {}),
    };
  }
  if (st.committee !== undefined) {
    const judge =
      st.committee.judge !== undefined
        ? resolveModelOnly(st.committee.judge, ctx, `${path}.committee.judge`)
        : undefined;
    out.committee = {
      members: st.committee.members.map(lowerRoleSlot),
      ...(judge !== undefined ? { judge: judge.model } : {}),
      ...(judge?.profile !== undefined ? { judgeProfile: judge.profile } : {}),
      ...(st.committee.escalate_on_disagreement !== undefined
        ? { escalateOnDisagreement: lowerRoleSlot(st.committee.escalate_on_disagreement) }
        : {}),
    };
  }
  if (st.model_directed !== undefined) out.modelDirected = st.model_directed;
  if (st.max_escalations !== undefined) out.maxEscalations = st.max_escalations;
  return out;
}

function lowerPoolReward(r: NonNullable<SpecModelPoolBlockValue["reward"]>): IrModelPoolReward {
  return {
    ...(r.quality_source !== undefined ? { qualitySource: r.quality_source } : {}),
    ...(r.priors !== undefined ? { priors: r.priors } : {}),
    ...(r.floor !== undefined
      ? {
          floor: {
            ...(r.floor.arm !== undefined ? { arm: lowerRoleSlot(r.floor.arm) } : {}),
            ...(r.floor.confidence !== undefined ? { confidence: r.floor.confidence } : {}),
            ...(r.floor.tolerance !== undefined ? { tolerance: r.floor.tolerance } : {}),
          },
        }
      : {}),
    ...(r.reset_on_profile_change !== undefined
      ? { resetOnProfileChange: r.reset_on_profile_change }
      : {}),
  };
}

/**
 * Item 22 / item 26 / adaptive routing / 0.6.0 §7 — lower the model-routing
 * fields off an agent-like block (`model_fallbacks` + `circuit_breaker`,
 * `model_tiers`, `model_pool`). Mirrors `lowerCompaction`'s "propagate only
 * defined fields" discipline: the breaker package owns the per-knob
 * defaults, so the IR carries the user's intent verbatim. Returns a partial
 * spread into the IR block so every field stays ABSENT when the spec omits
 * it (emitters gate their codegen on presence).
 *
 * 0.6.0: every model slot here resolves through {@link resolveModelRef}
 * (`$profile` / `cheapest` / `strongest`); candidates lower through
 * {@link lowerPoolCandidate}; the hybrid siblings (`directives` / `rules` /
 * `classifier` / `strategy` / `reward` / `scope`) ride the pool blob, each
 * reported `model-plan-pending-runtime` until its consumer lands. `scope` is
 * carried verbatim only when declared — the compiler does NOT stamp the
 * step/role/node name (§7.9) at lower time, because the IR pool blob is what
 * README / loop projections and every emitter read. The host that knows the
 * scope stamps it where the loop options are assembled instead:
 * `@crewhaus/crew-orchestrator` hands each role turn its pool with `scope`
 * defaulted to the ROLE name (PR 7b, `scopeRolePool`); the workflow and
 * graph emitters render each pooled step's / node's blob with `scope`
 * defaulted to the step / node name (PR 9a, `@crewhaus/model-service`'s
 * `scopedModelWiringFragment`); runtime-core falls back to the caller's
 * `toolsetScope` and stamps the result on `model_route.scope`.
 */
function lowerModelFailover(
  agent: SpecAgentWithFailover,
  ctx: LowerContext,
  path: string,
): {
  modelFallbacks?: readonly string[];
  circuitBreaker?: IrCircuitBreaker;
  modelTiers?: IrModelTiers;
  modelPool?: IrModelPool;
} {
  const out: {
    modelFallbacks?: readonly string[];
    circuitBreaker?: IrCircuitBreaker;
    modelTiers?: IrModelTiers;
    modelPool?: IrModelPool;
  } = {};
  if (agent.model_fallbacks !== undefined && agent.model_fallbacks.length > 0) {
    out.modelFallbacks = agent.model_fallbacks.map(
      (m, i) => resolveModelOnly(m, ctx, `${path}.model_fallbacks[${i}]`).model,
    );
  }
  const cb = agent.circuit_breaker;
  if (cb !== undefined) out.circuitBreaker = lowerCircuitBreaker(cb);
  // Item 26 — two-tier router. Only lowered when present; the routing knobs
  // carry the user's intent verbatim (runtime owns the per-knob defaults).
  const mt = agent.model_tiers;
  if (mt !== undefined) {
    const routing = mt.routing;
    out.modelTiers = {
      fast: resolveModelOnly(mt.fast, ctx, `${path}.model_tiers.fast`).model,
      default: resolveModelOnly(mt.default, ctx, `${path}.model_tiers.default`).model,
      ...(routing !== undefined
        ? {
            routing: {
              ...(routing.contextTokenThreshold !== undefined
                ? { contextTokenThreshold: routing.contextTokenThreshold }
                : {}),
              ...(routing.toolsToDefault !== undefined
                ? { toolsToDefault: routing.toolsToDefault }
                : {}),
              ...(routing.firstTurnToDefault !== undefined
                ? { firstTurnToDefault: routing.firstTurnToDefault }
                : {}),
              ...(routing.priorToolDensityThreshold !== undefined
                ? { priorToolDensityThreshold: routing.priorToolDensityThreshold }
                : {}),
            },
          }
        : {}),
    };
  }
  // Adaptive model routing — lower the N-candidate pool. `policy` and each
  // candidate's `tags` are always present (spec defaults them); every other
  // knob carries the user's intent verbatim (runtime owns the per-knob
  // defaults), so only defined optional blocks are attached.
  const mp = agent.model_pool;
  if (mp !== undefined) {
    const poolPath = `${path}.model_pool`;
    const objective = mp.objective;
    const routing = mp.routing;
    const learning = mp.learning;
    const pending = (key: string, landing: string, extra = ""): void =>
      warn(
        ctx,
        "model-plan-pending-runtime",
        `${poolPath}.${key}`,
        `${poolPath}.${key} is lowered into the pool blob but the runtime does not honour it yet — it lands with 0.6.0 ${landing}; until then it is inert${extra}`,
      );
    if (mp.policy === "classifier") {
      pending("policy", LANDING_PREROUTE, " (the pool routes heuristically until then)");
    }
    if (mp.directives !== undefined) pending("directives", LANDING_PREROUTE);
    if (mp.rules !== undefined) pending("rules", LANDING_PREROUTE);
    if (mp.classifier !== undefined) pending("classifier", LANDING_PREROUTE);
    if (mp.strategy !== undefined) {
      pending("strategy", LANDING_STRATEGIES);
      if (mp.strategy.model_directed === true) {
        // 0.6.0 PR 8b landed the runtime half: `wireModels` constructs the
        // Consult / Escalate pair under this key, and the `crewhaus run` /
        // `crewhaus serve` interpreter reaches it. A COMPILED bundle does not
        // yet — every emitter still renders the four routing fields through
        // `renderModelWiringFields`, which never renders the hybrid pair —
        // so the warning is scoped to compiled targets, not "the runtime".
        warn(
          ctx,
          "model-plan-pending-runtime",
          `${poolPath}.strategy.model_directed`,
          `${poolPath}.strategy.model_directed is honoured by the crewhaus run / serve interpreter (Consult and Escalate are registered from @crewhaus/tool-consult), but a compiled bundle does not register the tools yet — that lands with 0.6.0 ${LANDING_MODEL_DIRECTED}; until then the key is inert in compiled targets`,
        );
      }
    }
    if (mp.reward !== undefined) pending("reward", LANDING_ROUTER_STORE);
    // `scope` is consumed since PR 9a (stamped on `model_route.scope`); the
    // routing store keys arms by it from PR 10 on.
    out.modelPool = {
      candidates: mp.candidates.map((c, i) =>
        lowerPoolCandidate(c, ctx, `${poolPath}.candidates[${i}]`),
      ),
      policy: mp.policy,
      ...(objective !== undefined
        ? {
            objective: {
              ...(objective.quality !== undefined ? { quality: objective.quality } : {}),
              ...(objective.cost !== undefined ? { cost: objective.cost } : {}),
              ...(objective.latency !== undefined ? { latency: objective.latency } : {}),
            },
          }
        : {}),
      ...(routing !== undefined
        ? {
            routing: {
              ...(routing.contextTokenThreshold !== undefined
                ? { contextTokenThreshold: routing.contextTokenThreshold }
                : {}),
              ...(routing.toolsToDefault !== undefined
                ? { toolsToDefault: routing.toolsToDefault }
                : {}),
              ...(routing.firstTurnToDefault !== undefined
                ? { firstTurnToDefault: routing.firstTurnToDefault }
                : {}),
              ...(routing.priorToolDensityThreshold !== undefined
                ? { priorToolDensityThreshold: routing.priorToolDensityThreshold }
                : {}),
              ...(routing.strongTag !== undefined ? { strongTag: routing.strongTag } : {}),
              ...(routing.cheapTag !== undefined ? { cheapTag: routing.cheapTag } : {}),
            },
          }
        : {}),
      ...(learning !== undefined
        ? {
            learning: {
              ...(learning.minSamplesPerArm !== undefined
                ? { minSamplesPerArm: learning.minSamplesPerArm }
                : {}),
              ...(learning.costRefUsd !== undefined ? { costRefUsd: learning.costRefUsd } : {}),
              ...(learning.latencyRefMs !== undefined
                ? { latencyRefMs: learning.latencyRefMs }
                : {}),
              ...(learning.explorationRate !== undefined
                ? { explorationRate: learning.explorationRate }
                : {}),
              ...(learning.seed !== undefined ? { seed: learning.seed } : {}),
              ...(learning.bandit !== undefined ? { bandit: learning.bandit } : {}),
            },
          }
        : {}),
      // 0.6.0 §7.1 — the hybrid container, each sibling only when declared.
      ...(mp.directives !== undefined ? { directives: mp.directives } : {}),
      ...(mp.rules !== undefined ? { rules: lowerPoolRules(mp.rules) } : {}),
      ...(mp.classifier !== undefined
        ? { classifier: lowerPoolClassifier(mp.classifier, ctx, `${poolPath}.classifier`) }
        : {}),
      ...(mp.strategy !== undefined
        ? { strategy: lowerPoolStrategy(mp.strategy, ctx, `${poolPath}.strategy`) }
        : {}),
      ...(mp.reward !== undefined ? { reward: lowerPoolReward(mp.reward) } : {}),
      ...(mp.scope !== undefined ? { scope: mp.scope } : {}),
    };
  }
  return out;
}

/**
 * Section 55 (Track A) — lower the optional `failure_taxonomy` block.
 * The lower is 1:1 (no normalisation, no dedup, no reordering) so
 * `failureTaxonomy` is added to `OPTIMIZABLE_PATHS` directly.
 *
 * Returns `{ failureTaxonomy: [...] }` when present, `{}` when omitted —
 * spread into the IR so the field stays absent in the latter case
 * (emitters can `if ("failureTaxonomy" in ir)` to gate their codegen).
 */
type SpecWithFailureTaxonomy = {
  readonly failure_taxonomy?: ReadonlyArray<{
    readonly class: string;
    readonly pattern: string;
    readonly recovery: "retry" | "compact" | "continue" | "tombstone" | "switch-model" | "fail";
    readonly hint?: string;
  }>;
};

function lowerFailureTaxonomy(spec: SpecWithFailureTaxonomy): {
  failureTaxonomy?: ReadonlyArray<IrFailureTaxonomyEntry>;
} {
  const t = spec.failure_taxonomy;
  if (t === undefined || t.length === 0) return {};
  // Preserve insertion order; recovery engine evaluates entries top-to-bottom
  // and uses the first match. Reordering would change semantics, so the
  // lower is intentionally pass-through.
  return {
    failureTaxonomy: t.map((e) =>
      e.hint !== undefined
        ? { class: e.class, pattern: e.pattern, recovery: e.recovery, hint: e.hint }
        : { class: e.class, pattern: e.pattern, recovery: e.recovery },
    ),
  };
}

/**
 * Item 27 — lower the optional `budget` block. Converts the human-facing
 * dollar ceiling (`usd`) to the runtime's USD-micros unit (× 1e6, rounded
 * so a fractional cent doesn't drift) and maps `on_exceed.action` → the
 * IR's `onExceed.kind`. Spread-return-{} discipline (Pillar 1): absent from
 * the IR when the spec omits the block.
 */
type SpecWithBudget = {
  readonly budget?: {
    readonly usd: number;
    readonly on_exceed:
      | { readonly action: "stop" }
      | { readonly action: "degrade"; readonly model: string };
    readonly scope?: "run" | "session";
    readonly judge_share?: number;
  };
};

function lowerBudget(spec: SpecWithBudget, ctx: LowerContext): { budget?: IrBudget } {
  const b = spec.budget;
  if (b === undefined) return {};
  const usdMicros = Math.round(b.usd * 1_000_000);
  let onExceed: IrBudget["onExceed"];
  if (b.on_exceed.action === "degrade") {
    // 0.6.0 §4.3 — the degrade rung is an auxiliary slot: `$profile` /
    // `cheapest` / `strongest` resolve here (it bypassed `resolveAuxModel`
    // before), with the profile's params beside the concrete model.
    const slot = resolveAuxSlot(b.on_exceed.model, ctx, "budget.on_exceed.model");
    onExceed = { kind: "degrade", model: slot.model, ...auxSlotFields(slot) };
  } else {
    onExceed = { kind: "stop" };
  }
  // 0.6.0 §7.12 / §6.2 — `scope` and `judgeShare` are spread ONLY when
  // declared: every emitter writes `JSON.stringify(ir.budget)` verbatim, so
  // an absent key keeps pre-0.6.0 bundles byte-identical while the runtime
  // defaults to `run` / 0.3.
  return {
    budget: {
      usdMicros,
      onExceed,
      ...(b.scope !== undefined ? { scope: b.scope } : {}),
      ...(b.judge_share !== undefined ? { judgeShare: b.judge_share } : {}),
    },
  };
}

/**
 * Loop contract 0.4 (Batch A) — lower the top-level `limits:` block.
 * Snake_case spec keys map to camelCase IR keys 1:1; every field is carried
 * verbatim only when declared (the runtime owns per-knob defaults), and the
 * whole key stays ABSENT when the spec omits the block (spread-return-{}
 * discipline, Pillar 1). The crew shape's `limits.crew` sub-block rides the
 * same lowering — it is only ever present there because the spec rejects it
 * on every other shape.
 */
type SpecWithLimits = {
  readonly limits?: {
    readonly max_tool_iterations?: number;
    readonly max_concurrent_tools?: number;
    readonly context_limit?: number;
    readonly deadline_ms?: number;
    readonly turn_timeout_ms?: number;
    readonly model_call_timeout_ms?: number;
    readonly loop_detection?: {
      readonly window?: number;
      readonly threshold?: number;
      readonly escalation?: "warn" | "justify" | "abort";
    };
    readonly crew?: {
      readonly max_activations?: number;
      readonly refusal_depth?: number;
      readonly max_a2a_depth?: number;
    };
  };
};

function lowerLimits(spec: SpecWithLimits): { limits?: IrLimits } {
  const l = spec.limits;
  if (l === undefined) return {};
  const ld = l.loop_detection;
  const crew = l.crew;
  return {
    limits: {
      ...(l.max_tool_iterations !== undefined ? { maxToolIterations: l.max_tool_iterations } : {}),
      ...(l.max_concurrent_tools !== undefined
        ? { maxConcurrentTools: l.max_concurrent_tools }
        : {}),
      ...(l.context_limit !== undefined ? { contextLimit: l.context_limit } : {}),
      ...(l.deadline_ms !== undefined ? { deadlineMs: l.deadline_ms } : {}),
      ...(l.turn_timeout_ms !== undefined ? { turnTimeoutMs: l.turn_timeout_ms } : {}),
      ...(l.model_call_timeout_ms !== undefined
        ? { modelCallTimeoutMs: l.model_call_timeout_ms }
        : {}),
      ...(ld !== undefined
        ? {
            loopDetection: {
              ...(ld.window !== undefined ? { window: ld.window } : {}),
              ...(ld.threshold !== undefined ? { threshold: ld.threshold } : {}),
              ...(ld.escalation !== undefined ? { escalation: ld.escalation } : {}),
            },
          }
        : {}),
      ...(crew !== undefined
        ? {
            crew: {
              ...(crew.max_activations !== undefined
                ? { maxActivations: crew.max_activations }
                : {}),
              ...(crew.refusal_depth !== undefined ? { refusalDepth: crew.refusal_depth } : {}),
              ...(crew.max_a2a_depth !== undefined ? { maxA2aDepth: crew.max_a2a_depth } : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * Loop contract 0.4 (Batch F, temporal contract / G84 schedule half) — lower
 * the `schedule:` block on the daemon-able shapes (channel/managed/batch).
 * The discriminated union carries through 1:1; durations (`jitter`, interval
 * `every`) normalize to ms at lower time (the daemon reads literal numbers)
 * while `cron` is verbatim (the daemon's cron parser owns validity beyond the
 * spec's field-count regex). Spread-return-{} discipline (Pillar 1): absent
 * from the IR when the spec omits the block, so every existing daemon bundle
 * stays byte-identical. The emitters wire it into the wake loop downstream
 * (temporal item); until then it rides ACCEPTED_BUT_UNWIRED.
 */
type SpecSchedule =
  | {
      readonly kind: "cron";
      readonly cron: string;
      readonly timezone?: string;
      readonly jitter?: string;
      readonly instructions?: string;
    }
  | {
      readonly kind: "interval";
      readonly every: string;
      readonly jitter?: string;
      readonly instructions?: string;
    };

function lowerSchedule(schedule: SpecSchedule | undefined): { schedule?: IrSchedule } {
  if (schedule === undefined) return {};
  if (schedule.kind === "cron") {
    return {
      schedule: {
        kind: "cron",
        cron: schedule.cron,
        ...(schedule.timezone !== undefined ? { timezone: schedule.timezone } : {}),
        ...(schedule.jitter !== undefined ? { jitterMs: parseDurationToMs(schedule.jitter) } : {}),
        ...(schedule.instructions !== undefined ? { instructions: schedule.instructions } : {}),
      },
    };
  }
  return {
    schedule: {
      kind: "interval",
      everyMs: parseDurationToMs(schedule.every),
      ...(schedule.jitter !== undefined ? { jitterMs: parseDurationToMs(schedule.jitter) } : {}),
      ...(schedule.instructions !== undefined ? { instructions: schedule.instructions } : {}),
    },
  };
}

/**
 * Loop contract 0.4 (Batch A) — lower a `thinking` block (agent-level on
 * cli/channel/managed; step/node/role-level on workflow/graph/crew). The
 * spec's superRefine guarantees exactly one form, so the lowering is a
 * two-arm rename: `{ budget_tokens }` → `{ budgetTokens }`, `{ effort }`
 * carried verbatim. Spread-return-{} so the key stays absent when omitted.
 */
type SpecThinking = {
  readonly budget_tokens?: number;
  readonly effort?: "low" | "medium" | "high";
};

function lowerThinking(t: SpecThinking | undefined): { thinking?: IrThinking } {
  if (t === undefined) return {};
  if (t.budget_tokens !== undefined) return { thinking: { budgetTokens: t.budget_tokens } };
  if (t.effort !== undefined) return { thinking: { effort: t.effort } };
  // Unreachable past parseSpec (the superRefine demands exactly one form);
  // direct callers that hand-build spec fragments get the absent key.
  return {};
}

/**
 * Loop contract 0.4 (Batch A) — lower the top-level `hooks:` block. 1:1
 * except the snake_case rename (`timeout_ms` → `timeoutMs`); insertion
 * order preserved (hooks fire in declaration order, matching hooks-engine's
 * settings.json semantics). Spread-return-{} discipline.
 */
type SpecWithHooks = {
  readonly hooks?: ReadonlyArray<{
    readonly event: IrHook["event"];
    readonly matcher?: string;
    readonly command: string;
    readonly timeout_ms?: number;
  }>;
};

function lowerHooks(spec: SpecWithHooks): { hooks?: ReadonlyArray<IrHook> } {
  const h = spec.hooks;
  if (h === undefined || h.length === 0) return {};
  return {
    hooks: h.map((entry) => ({
      event: entry.event,
      command: entry.command,
      ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
      ...(entry.timeout_ms !== undefined ? { timeoutMs: entry.timeout_ms } : {}),
    })),
  };
}

/**
 * Loop contract 0.4 (Batch B, G02) — lower the top-level `evaluation:`
 * block (cli/channel/managed). `on_fail`/`max_retries` RESOLVE here
 * (defaults `"retry"` / 1) so emitters and the interpreter read one
 * deterministic shape; `threshold` resolves to 0.7 for the `llm_judge`
 * grader and stays ABSENT for the deterministic graders (they are
 * pass/fail — the spec rejects a declared threshold there). The judge
 * model rides the item-25 aux-model machinery, so `cheapest` resolves at
 * compile time exactly like `compaction.model`. Spread-return-{}
 * discipline: the IR key stays absent when the spec omits the block.
 */
type SpecWithEvaluation = SpecWithPermissions & {
  readonly evaluation?: {
    readonly grader:
      | {
          readonly type: "llm_judge";
          readonly criteria: string;
          readonly model?: string;
          readonly judges?: readonly string[];
          readonly repeats?: number;
          readonly temperature?: number;
          readonly target?: "output" | "transcript";
        }
      | { readonly type: "contains"; readonly value: string }
      | { readonly type: "regex"; readonly value: string };
    readonly threshold?: number;
    readonly on_fail?: "retry" | "halt" | "note" | "escalate";
    readonly max_retries?: number;
    readonly allow_self_judge?: boolean;
  };
};

/** The §6.2 judge-panel knobs a grader / gate shares, lowered + reported pending. */
function lowerJudgePanel(
  judge: {
    readonly judges?: readonly string[];
    readonly repeats?: number;
    readonly temperature?: number;
    readonly target?: "output" | "transcript";
  },
  slot: SingleSlotResult | undefined,
  ctx: LowerContext,
  path: string,
): {
  judges?: readonly string[];
  repeats?: number;
  temperature?: number;
  target?: "output" | "transcript";
  params?: IrModelParams;
} {
  const judges = judge.judges?.map(
    (m, i) => resolveModelOnly(m, ctx, `${path}.judges[${i}]`).model,
  );
  // The judge's own pinned temperature wins over the profile's; the rest of
  // the profile's params ride `params` for the request builder.
  const temperature = judge.temperature ?? slot?.params?.temperature;
  const rest: IrModelParams = {
    ...(slot?.params?.thinking !== undefined ? { thinking: slot.params.thinking } : {}),
    ...(slot?.params?.maxTokens !== undefined ? { maxTokens: slot.params.maxTokens } : {}),
  };
  for (const [key, present] of [
    ["judges", judge.judges !== undefined],
    ["repeats", judge.repeats !== undefined],
    ["temperature", judge.temperature !== undefined],
    ["target", judge.target !== undefined],
  ] as const) {
    if (!present) continue;
    warn(
      ctx,
      "model-plan-pending-runtime",
      `${path}.${key}`,
      `${path}.${key} is lowered into the IR but the judge site still calls judge() with the single model — it lands with 0.6.0 ${LANDING_JUDGE_PANEL}; until then it is inert`,
    );
  }
  return {
    ...(judges !== undefined ? { judges } : {}),
    ...(judge.repeats !== undefined ? { repeats: judge.repeats } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(judge.target !== undefined ? { target: judge.target } : {}),
    ...(Object.keys(rest).length > 0 ? { params: rest } : {}),
  };
}

/**
 * Loop contract 0.4 (Batch B, G02) — lower the top-level `evaluation:`
 * block (cli/channel/managed). `on_fail`/`max_retries` RESOLVE here
 * (defaults `"retry"` / 1) so emitters and the interpreter read one
 * deterministic shape; `threshold` resolves to 0.7 for the `llm_judge`
 * grader and stays ABSENT for the deterministic graders (they are
 * pass/fail — the spec rejects a declared threshold there). The judge
 * model is an auxiliary slot (`$profile` / `cheapest` / `strongest`
 * resolve at compile time exactly like `compaction.model`).
 * Spread-return-{} discipline: the IR key stays absent when the spec omits
 * the block. 0.6.0 §6.2 / §7.3: the judge panel knobs, `on_fail: escalate`
 * (reachable only with `allowRuntimePendingKeys` until PR 9c) and the
 * `allow_self_judge` lint waiver (carried only when true).
 */
function lowerEvaluation(
  spec: SpecWithEvaluation,
  ctx: LowerContext,
): { evaluation?: IrEvaluation } {
  const e = spec.evaluation;
  if (e === undefined) return {};
  let grader: IrEvaluation["grader"];
  if (e.grader.type === "llm_judge") {
    const slot =
      e.grader.model !== undefined
        ? resolveAuxSlot(e.grader.model, ctx, "evaluation.grader.model")
        : defaultJudgeSlot(ctx, "evaluation.grader.model");
    grader = {
      type: "llm_judge",
      criteria: e.grader.criteria,
      ...(slot !== undefined ? { model: slot.model } : {}),
      ...(slot?.modelProfile !== undefined ? { modelProfile: slot.modelProfile } : {}),
      ...lowerJudgePanel(e.grader, slot, ctx, "evaluation.grader"),
    };
  } else if (e.grader.type === "contains") {
    grader = { type: "contains", value: e.grader.value };
  } else {
    grader = { type: "regex", value: e.grader.value };
  }
  if (e.on_fail === "escalate") {
    warn(
      ctx,
      "model-plan-pending-runtime",
      "evaluation.on_fail",
      "evaluation.on_fail: escalate is lowered into the IR but the runtime re-runs a failed turn on the same policy today — it lands with 0.6.0 PR 9c (the cascade re-run on the escalation rung)",
    );
  }
  return {
    evaluation: {
      grader,
      ...(e.grader.type === "llm_judge" ? { threshold: e.threshold ?? 0.7 } : {}),
      onFail: e.on_fail ?? "retry",
      maxRetries: e.max_retries ?? 1,
      ...(e.allow_self_judge === true ? { allowSelfJudge: true as const } : {}),
    },
  };
}

/**
 * Loop contract 0.4 (Batch B, G02) — resolve a judge gate's knobs
 * (defaults: threshold 0.7, on_fail `"retry_previous"`, max_retries 1).
 * The judge MODEL is deliberately NOT part of `IrJudge`: the caller
 * resolves it into the judge step's/node's ordinary `model` field
 * (`judge.model ?? <shape>.model`, an auxiliary slot — `$profile` /
 * `cheapest` / `strongest` supported) so emitters read one model slot per
 * step/node. 0.6.0 §6.2 / §7.3: the panel knobs, the profile's params and
 * provenance, and `escalate_to` (a pool tag or arm id; reachable only with
 * `allowRuntimePendingKeys` until PR 9c).
 */
type SpecJudgeGateBlock = {
  readonly criteria: string;
  readonly model?: string;
  readonly threshold?: number;
  readonly on_fail?: "retry_previous" | "halt" | "continue";
  readonly max_retries?: number;
  readonly judges?: readonly string[];
  readonly repeats?: number;
  readonly temperature?: number;
  readonly target?: "output" | "transcript";
  readonly escalate_to?: string;
};

function lowerJudgeGate(
  judge: SpecJudgeGateBlock,
  slot: SingleSlotResult | undefined,
  ctx: LowerContext,
  path: string,
): IrJudge {
  if (judge.escalate_to !== undefined) {
    warn(
      ctx,
      "model-plan-pending-runtime",
      `${path}.escalate_to`,
      `${path}.escalate_to is lowered into the IR but a retry_previous re-run keeps the gated block's own routing today — it lands with 0.6.0 PR 9c (the forced re-run on the escalation rung)`,
    );
  }
  return {
    criteria: judge.criteria,
    threshold: judge.threshold ?? 0.7,
    onFail: judge.on_fail ?? "retry_previous",
    maxRetries: judge.max_retries ?? 1,
    ...(slot?.modelProfile !== undefined ? { modelProfile: slot.modelProfile } : {}),
    ...lowerJudgePanel(judge, slot, ctx, path),
    ...(judge.escalate_to !== undefined ? { escalateTo: lowerRoleSlot(judge.escalate_to) } : {}),
  };
}

/**
 * Loop contract 0.4 (Batch A) — lower `agent.rate_limits` (cli/channel/
 * managed). Values are carried verbatim under a frozen map; keys are tool
 * names or `"*"`. Spread-return-{} discipline.
 */
type SpecRateLimits = Readonly<Record<string, { readonly rpm: number; readonly burst?: number }>>;

function lowerRateLimits(rateLimits: SpecRateLimits | undefined): {
  rateLimits?: Readonly<Record<string, { readonly rpm: number; readonly burst?: number }>>;
} {
  if (rateLimits === undefined || Object.keys(rateLimits).length === 0) return {};
  const out: Record<string, { rpm: number; burst?: number }> = {};
  for (const [tool, limit] of Object.entries(rateLimits)) {
    out[tool] = {
      rpm: limit.rpm,
      ...(limit.burst !== undefined ? { burst: limit.burst } : {}),
    };
  }
  return { rateLimits: Object.freeze(out) };
}

/**
 * Pillar 3 (FR-004) — lower the optional `security` block. Mirrors
 * `lowerCompaction`'s "propagate only defined fields" discipline:
 * defaults belong at the consumer (the cli run path defaults the judge
 * model to a haiku-class id), so the IR carries the user's intent
 * without lying about defaults.
 *
 * Returns `{ security: {...} }` only when the spec declares a
 * `justification` sub-block, `{}` otherwise — spread into the IR so the
 * `security` field stays absent when omitted (Pillar 1: emitters/the run
 * path check presence). `egressPolicy` is intentionally not handled here
 * (reserved for FR-002/006).
 */
type SpecWithSecurity = {
  readonly security?: {
    readonly justification?: {
      readonly judge: "rule-based" | "claude";
      readonly model?: string;
    };
    readonly egressMatcher?: "substring" | "semantic";
  };
};

function lowerSecurity(spec: SpecWithSecurity, ctx: LowerContext): { security?: IrSecurity } {
  const s = spec.security;
  if (s === undefined) return {};
  // FR-004 `justification` and FR-006 `egressMatcher` are independent
  // optional sub-fields of the same `security` block: carry whichever is
  // present. The block is dropped from the IR only when both are absent.
  // 0.6.0 §4.3 — the justification judge model is an auxiliary slot
  // (`$profile` / `cheapest` / `strongest`; it bypassed `resolveAuxModel`).
  const judgeSlot =
    s.justification?.model !== undefined
      ? resolveAuxSlot(s.justification.model, ctx, "security.justification.model")
      : undefined;
  const justification =
    s.justification !== undefined
      ? {
          judge: s.justification.judge,
          ...(judgeSlot !== undefined
            ? { model: judgeSlot.model, ...auxSlotFields(judgeSlot) }
            : {}),
        }
      : undefined;
  const egressMatcher = s.egressMatcher;
  if (justification === undefined && egressMatcher === undefined) return {};
  return {
    security: {
      ...(justification !== undefined ? { justification } : {}),
      ...(egressMatcher !== undefined ? { egressMatcher } : {}),
    },
  };
}

type SpecWithFeedback = {
  readonly feedback?: {
    readonly enabled?: boolean;
    readonly modality: "binary" | "stars" | "scale" | "comment";
    readonly scale?: { readonly min: number; readonly max: number };
    readonly storage?: { readonly location: string };
    readonly autoDistill?: boolean;
    readonly exitPrompt?: boolean;
    readonly channelReactions?: boolean;
  };
};

// Lower the cross-cutting `feedback` block, mirroring lowerSecurity's
// spread-return-{} discipline (Pillar 1): the key is absent from the IR when
// the spec omits the block. `modality` has a Zod .default("binary") so it is
// always present post-parse — carry it verbatim.
function lowerFeedback(spec: SpecWithFeedback): { feedback?: IrFeedback } {
  const f = spec.feedback;
  if (f === undefined) return {};
  return {
    feedback: {
      modality: f.modality,
      ...(f.enabled !== undefined ? { enabled: f.enabled } : {}),
      ...(f.scale !== undefined ? { scale: { min: f.scale.min, max: f.scale.max } } : {}),
      ...(f.storage !== undefined ? { storage: { location: f.storage.location } } : {}),
      ...(f.autoDistill !== undefined ? { autoDistill: f.autoDistill } : {}),
      ...(f.exitPrompt !== undefined ? { exitPrompt: f.exitPrompt } : {}),
      ...(f.channelReactions !== undefined ? { channelReactions: f.channelReactions } : {}),
    },
  };
}

type SpecWithMemory = {
  readonly memory?: {
    readonly enabled?: boolean;
    readonly backend?: "file" | "thredz";
    readonly embedder?: string;
    readonly ttl?: string;
    readonly autoCapture?: boolean;
    readonly autoCaptureThreshold?: number;
    readonly autoRecall?: boolean | "session-start" | "per-turn";
    readonly refreshEvery?: number;
    readonly sessionRecall?: boolean;
    readonly recallK?: number;
    readonly wiki?: {
      readonly enabled?: boolean;
      readonly recallK?: number;
      readonly embedder?: string;
      readonly autoRecall?: boolean;
      readonly requireSources?: boolean;
    };
    readonly dream?: {
      readonly every: string;
      readonly mode?: "deterministic" | "full";
      readonly budget_usd?: number;
      readonly instructions?: string;
    };
  };
};

/** v0.3.0 — floor for `memory.ttl`. A sub-hour fact TTL is almost certainly
 *  a unit mistake (facts would expire mid-session); reject it loudly at
 *  compile time. LOAD-BEARING here (the first line, with the better
 *  message), mirrored (validation-only) by ir-passes' `memoryIntegrityPass`
 *  — which G45 now also runs unconditionally inside compile() and which
 *  remains the audit for direct-IR builders. */
const MEMORY_TTL_MIN_MS = 60 * 60 * 1000;

/** v0.3.0 PR 14 — floor for `memory.dream.every`. Consolidation is a
 *  maintenance pass (design §6: "on a schedule, not every turn"); a
 *  sub-5-minute cadence is a unit mistake that would thrash the stores and
 *  — in `full` mode — burn model budget continuously. LOAD-BEARING here,
 *  mirrored by ir-passes' `memoryIntegrityPass` (same posture as the ttl
 *  floor above). */
const DREAM_EVERY_MIN_MS = 5 * 60 * 1000;

// Lower the cross-cutting `memory` block (#53), mirroring lowerFeedback's
// spread-return-{} discipline (Pillar 1): the key is absent from the IR when
// the spec omits the block, so codegen/runtime check presence to decide
// whether to wire Remember/Recall + the auto-capture/recall paths.
//
// v0.3.0 (§9) — `backend`/`ttl`/`wiki`/`dream` join the block. `ttl` and
// `dream.every` are parsed to milliseconds here (the heartbeat duration
// grammar extended with `d`) so the runtime/fragment read literal numbers;
// `dream.mode` is RESOLVED to its default (`full`) so downstream reads one
// deterministic shape; every other field keeps the declared-fields-only
// discipline so pre-0.3.0 memory bundles stay byte-identical.
//
// Loop contract 0.4 (Batch E):
//   - G46 (mildly breaking) — with the block PRESENT, `autoRecall` and
//     `autoCapture` RESOLVE to `true` when omitted (they previously defaulted
//     to false). The resolved booleans are always stamped into the IR, so a
//     bundle no longer depends on a runtime default; opt out with
//     `autoRecall: false` / `autoCapture: false`.
//   - G21 — `autoRecall`'s string form + `refreshEvery` resolve into
//     `recallMode` (`"per-turn"` carried only when the interactive cadence is
//     selected; `"session-start"` is the implicit default) + `refreshEvery`.
//     `refreshEvery` alongside `autoRecall: false` is a contradiction
//     (LOAD-BEARING throw — the interactive refresh has nothing to refresh).
//   - G77 — `sessionRecall` carried only when the spec opted in.
function lowerMemory(spec: SpecWithMemory): { memory?: IrMemory } {
  const m = spec.memory;
  if (m === undefined) return {};
  let ttlMs: number | undefined;
  if (m.ttl !== undefined) {
    ttlMs = parseDurationToMs(m.ttl);
    if (ttlMs < MEMORY_TTL_MIN_MS) {
      throw new CompilerError(
        `memory.ttl "${m.ttl}" is below the 1h floor — a sub-hour fact TTL expires memories mid-session. Use "1h" or longer (e.g. "90d"), or omit ttl to keep facts forever.`,
      );
    }
  }
  const d = m.dream;
  let dreamEveryMs: number | undefined;
  if (d !== undefined) {
    dreamEveryMs = parseDurationToMs(d.every);
    if (dreamEveryMs < DREAM_EVERY_MIN_MS) {
      throw new CompilerError(
        `memory.dream.every "${d.every}" is below the 5m floor — consolidation is a scheduled maintenance pass, not a per-turn hook (a sub-5-minute cadence thrashes the stores and, in "full" mode, burns model budget continuously). Use "5m" or longer (e.g. "24h").`,
      );
    }
  }
  const w = m.wiki;
  // Loop contract 0.4 — G46 default-on + G21 per-turn cadence, RESOLVED here.
  const ar = m.autoRecall;
  const autoRecallOn = ar === undefined ? true : ar !== false;
  const autoCaptureOn = m.autoCapture ?? true;
  if (m.refreshEvery !== undefined && !autoRecallOn) {
    throw new CompilerError(
      `memory.refreshEvery re-runs auto-recall each turn, but autoRecall is false — set autoRecall: per-turn (or omit it / true / "session-start") to enable recall, or drop refreshEvery.`,
    );
  }
  // "per-turn" when explicitly selected OR a refresh cadence was declared
  // (refreshEvery IS the "every N turns" knob). Otherwise session-start — the
  // implicit default, NOT carried, keeping the common case's IR lean.
  const perTurn = autoRecallOn && (ar === "per-turn" || m.refreshEvery !== undefined);
  return {
    memory: {
      ...(m.enabled !== undefined ? { enabled: m.enabled } : {}),
      ...(m.backend !== undefined ? { backend: m.backend } : {}),
      // Loop contract 0.4 (Batch A) — top-level fact-store embedder.
      // Runtime fallback order: embedder → wiki.embedder.
      ...(m.embedder !== undefined ? { embedder: m.embedder } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      // Loop contract 0.4 (Batch E, G46) — auto-capture/recall are now
      // RESOLVED booleans (default true when the block is present).
      autoCapture: autoCaptureOn,
      ...(m.autoCaptureThreshold !== undefined
        ? { autoCaptureThreshold: m.autoCaptureThreshold }
        : {}),
      autoRecall: autoRecallOn,
      // Loop contract 0.4 (Batch E, G21) — per-turn recall cadence.
      ...(perTurn ? { recallMode: "per-turn" as const } : {}),
      ...(perTurn && m.refreshEvery !== undefined ? { refreshEvery: m.refreshEvery } : {}),
      // Loop contract 0.4 (Batch E, G77) — session-summary recall ranker.
      ...(m.sessionRecall !== undefined ? { sessionRecall: m.sessionRecall } : {}),
      ...(m.recallK !== undefined ? { recallK: m.recallK } : {}),
      ...(w !== undefined
        ? {
            wiki: {
              ...(w.enabled !== undefined ? { enabled: w.enabled } : {}),
              ...(w.recallK !== undefined ? { recallK: w.recallK } : {}),
              ...(w.embedder !== undefined ? { embedder: w.embedder } : {}),
              ...(w.autoRecall !== undefined ? { autoRecall: w.autoRecall } : {}),
              ...(w.requireSources !== undefined ? { requireSources: w.requireSources } : {}),
            },
          }
        : {}),
      ...(d !== undefined && dreamEveryMs !== undefined
        ? {
            dream: {
              everyMs: dreamEveryMs,
              // Resolved default (design §6.1): mode is `full` unless the
              // spec said `deterministic` — the model phase still needs
              // budget_usd > 0 to ever run.
              mode: d.mode ?? "full",
              ...(d.budget_usd !== undefined ? { budgetUsd: d.budget_usd } : {}),
              ...(d.instructions !== undefined ? { instructions: d.instructions } : {}),
            },
          }
        : {}),
    },
  };
}

// Loop contract 0.4 (Batch E, G22) — the agent-shape RAG (`knowledge:`)
// block. Defaults MIRROR target-pipeline's retrieve/indexing so the shared
// `@crewhaus/tool-retrieve` engine reads the same baseline whether it was
// configured via the pipeline shape or the knowledge block.
const KNOWLEDGE_DEFAULT_BACKEND: IrVectorBackend = "in-memory";
const KNOWLEDGE_DEFAULT_K = 5;
const KNOWLEDGE_DEFAULT_CHUNK_SIZE = 400;
const KNOWLEDGE_DEFAULT_CHUNK_OVERLAP = 0;

type SpecWithKnowledge = {
  readonly knowledge?: {
    readonly embedder?: string;
    readonly vector_backend?: IrVectorBackend;
    readonly sources: ReadonlyArray<{
      readonly path?: string;
      readonly glob?: string;
      readonly url?: string;
    }>;
    readonly chunk?: { readonly size?: number; readonly overlap?: number };
    readonly default_k?: number;
  };
};

/**
 * Lower the `knowledge:` block to a RESOLVED `IrKnowledge`: the backend /
 * default-K / chunk knobs resolve to the pipeline defaults so the retrieve
 * engine reads concrete values, `embedder` is carried only when declared
 * (resolution order `knowledge.embedder → memory.embedder →
 * memory.wiki.embedder → default` is a runtime/emitter concern — the IR
 * carries the raw string). The spec's exactly-one-of superRefine already
 * validated each source, so the path/glob/url discrimination is total (the
 * final throw is unreachable defence for direct-IR-less callers).
 */
function lowerKnowledge(spec: SpecWithKnowledge): { knowledge?: IrKnowledge } {
  const k = spec.knowledge;
  if (k === undefined) return {};
  return {
    knowledge: {
      ...(k.embedder !== undefined ? { embedder: k.embedder } : {}),
      vectorBackend: k.vector_backend ?? KNOWLEDGE_DEFAULT_BACKEND,
      defaultK: k.default_k ?? KNOWLEDGE_DEFAULT_K,
      chunkSize: k.chunk?.size ?? KNOWLEDGE_DEFAULT_CHUNK_SIZE,
      chunkOverlap: k.chunk?.overlap ?? KNOWLEDGE_DEFAULT_CHUNK_OVERLAP,
      sources: k.sources.map((s) => {
        if (s.path !== undefined) return { kind: "path" as const, path: s.path };
        if (s.glob !== undefined) return { kind: "glob" as const, glob: s.glob };
        if (s.url !== undefined) return { kind: "url" as const, url: s.url };
        throw new CompilerError(
          "knowledge source declared none of path/glob/url (unreachable after spec validation)",
        );
      }),
    },
  };
}

type SpecContinuity =
  | boolean
  | {
      readonly enabled?: boolean;
      readonly plan?: boolean;
      readonly proof?: "ladder" | "require" | "off";
      readonly ledger?: boolean;
      readonly handoff?: boolean;
      readonly scope?: "auto" | "spec" | "session";
      readonly focusMaxChars?: number;
    };

type SpecWithContinuity = {
  readonly continuity?: SpecContinuity;
};

/**
 * v0.3.0 Goal 1 (§2.1) — lower the top-level `continuity:` block.
 *
 * This is THE release's one sanctioned exception to the absent-equals-
 * byte-identical rule (design §1 principle 3): on the five emit-wired
 * agent-loop shapes (`defaultOn: true` — cli, channel, managed, research,
 * crew) an ABSENT key lowers to the default-on IrContinuity; only
 * `continuity: false` (or `{enabled: false}`) lowers to nothing, restoring
 * prior bundle bytes exactly (byte-diff-pinned). On the carried shapes
 * (`defaultOn: false` — workflow, batch, voice, browser) the block lowers
 * only when declared, and their emitters print the ignored-note comment.
 *
 * `scope: "auto"` (or absent) resolves HERE, per shape (§2.7/§14.5):
 * cli/research/crew → `spec`; channel → `session` (per-conversation stores
 * riding the session router's sessionId through wireMemory's `sessionScope`
 * dep); managed → `spec` + tenant fencing (deps carry the tenant at boot).
 * Explicit `scope: "session"` is only valid where a session router exists
 * (channel) — LOAD-BEARING validation lives here, with the ir-passes mirror
 * (G45: now also run unconditionally inside compile()) covering direct-IR
 * builders. Every other field is resolved to its default so the IR carries
 * one deterministic shape.
 */
function lowerContinuity(
  spec: SpecWithContinuity,
  shape: { readonly defaultOn: boolean; readonly autoScope: IrContinuity["scope"] },
): { continuity?: IrContinuity } {
  const c = spec.continuity;
  // The opt-out: `continuity: false` / `{enabled: false}` → no IR key.
  if (c === false) return {};
  if (typeof c === "object" && c.enabled === false) return {};
  // Absent on a carried (non-default-on) shape → no IR key.
  if (c === undefined && !shape.defaultOn) return {};

  const obj = typeof c === "object" ? c : {};
  const declaredScope = obj.scope ?? "auto";
  if (declaredScope === "session" && shape.autoScope !== "session") {
    throw new CompilerError(
      `continuity.scope "session" needs a shape with per-conversation session routing (channel) — this shape has no session router, so a session-scoped store would never resolve a session id. Use scope "spec" or "auto".`,
    );
  }
  const scope: IrContinuity["scope"] = declaredScope === "auto" ? shape.autoScope : declaredScope;
  return {
    continuity: {
      plan: obj.plan ?? true,
      proof: obj.proof ?? "ladder",
      ledger: obj.ledger ?? true,
      handoff: obj.handoff ?? true,
      scope,
      ...(obj.focusMaxChars !== undefined ? { focusMaxChars: obj.focusMaxChars } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// v0.3.0 Goal 3 (§4.1) — the `thredz:` block: one knob, lowered here.
// ---------------------------------------------------------------------------

/** The synthesized MCP server's name. Everything downstream — alias
 *  registration, the goal mirror, doctor's probe — keys on this. */
export const THREDZ_MCP_SERVER_NAME = "thredz";
/** Exact pin (design §4.1): the published stdio server whose v0.3.0 tool
 *  contract (27 tools incl. `goal_*`/`task_*`, the `wiki_space_*` pair,
 *  `THREDZ_DEFAULT_VISIBILITY` and `THREDZ_DEFAULT_SPACE`) the wiring layer is
 *  built against.
 *
 *  KEEP IN SYNC with `target-managed`'s copy — `thredz-pin-parity.test.ts`
 *  asserts the two literals match, because a drifted pin silently downgrades
 *  managed bundles to a server that ignores `space`. */
export const THREDZ_MCP_PACKAGE_SPEC = "thredz-mcp@0.3.0";

type SpecThredz =
  | boolean
  | string
  | {
      /** OPTIONAL because the crew superset allows a pure fan-out where every
       *  role brings its own key and there is no crew-wide one. The spec layer
       *  guarantees a key exists wherever one is required; `lowerThredzBlock`
       *  re-checks rather than trusting that across a package boundary. */
      readonly api_key?: string;
      readonly base_url?: string;
      readonly visibility?: "private" | "shared";
      readonly space?: string;
      readonly goals?: boolean;
      readonly agents?: boolean | string;
      readonly messaging?: boolean;
      /** 0.5.0, CREW ONLY — per-role overrides. Every other field on this
       *  object is the default a role inherits. */
      readonly roles?: Readonly<Record<string, SpecThredzRoleOverride>>;
    };

/** A role's slice of `thredz.roles.<name>` — every field of the object form
 *  except the fan-out map itself, and `api_key` optional because a role may
 *  inherit the crew-wide one. */
type SpecThredzRoleOverride = {
  readonly api_key?: string;
  readonly base_url?: string;
  readonly visibility?: "private" | "shared";
  readonly space?: string;
  readonly goals?: boolean;
  readonly agents?: boolean | string;
  readonly messaging?: boolean;
};

type SpecWithThredz = {
  readonly name: string;
  readonly thredz?: SpecThredz;
  readonly memory?: { readonly backend?: "file" | "thredz" };
};

/** Derive a Thredz agent handle (`^[a-z][a-z0-9-]{2,31}$`) from a spec name
 *  for `thredz.agents: true`. Deterministic; throws when the name reduces to
 *  nothing usable (the author then names the handle explicitly). */
function deriveThredzHandle(specName: string): string {
  let handle = specName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  handle = handle.replace(/^[^a-z]+/, "");
  handle = handle.slice(0, 32).replace(/-+$/g, "");
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(handle)) {
    throw new CompilerError(
      `thredz.agents: true cannot derive a valid agent handle from spec name ${JSON.stringify(specName)} — handles must match ^[a-z][a-z0-9-]{2,31}$. Name it explicitly, e.g. agents: my-expert.`,
    );
  }
  return handle;
}

/**
 * Lower the `thredz:` block to a RESOLVED `IrThredz` (shorthands expanded,
 * defaults filled in): `true` ≡ `{api_key: "$THREDZ_API_KEY"}`, a string is
 * the api_key, `visibility` defaults to `private` (design §4.3 — never
 * Thredz's shared-by-default), `goals` defaults to "on when continuity goals
 * are on" (the caller passes that fact), and `agents` resolves to a concrete
 * handle or stays absent. `api_key` rides `lowerCredential` — a typo'd
 * `$thredz_key` fails the compile, never ships as a baked literal.
 */
function lowerThredzBlock(spec: SpecWithThredz, continuityGoalsOn: boolean): IrThredz | undefined {
  const t = spec.thredz;
  if (t === undefined || t === false) return undefined;
  const obj =
    t === true ? { api_key: "$THREDZ_API_KEY" } : typeof t === "string" ? { api_key: t } : t;
  if (obj.api_key === undefined) {
    // Unreachable through parseSpec — the crew refinement requires a key per
    // role or a crew-wide one, and every other shape's schema makes api_key
    // required. Reachable by a direct-IR builder, and a silently missing
    // credential would mean a bundle that boots with no auth at all.
    throw new CompilerError(
      "thredz.api_key is missing — every Thredz block needs a key (a crew may give one per role under thredz.roles instead).",
    );
  }
  const agents = obj.agents;
  const agentName =
    agents === undefined || agents === false
      ? undefined
      : agents === true
        ? deriveThredzHandle(spec.name)
        : agents;
  return {
    apiKey: lowerCredential("thredz.api_key", obj.api_key),
    ...(obj.base_url !== undefined ? { baseUrl: obj.base_url } : {}),
    visibility: obj.visibility ?? "private",
    ...(obj.space !== undefined ? { space: obj.space } : {}),
    goals: obj.goals ?? continuityGoalsOn,
    ...(agentName !== undefined ? { agentName } : {}),
    // Item 5 (G44) — messaging tools stay OFF unless explicitly asked; carried
    // only when true so the default-off posture leaves the IR (and bundles)
    // byte-identical to pre-Batch-G.
    ...(obj.messaging === true ? { messaging: true } : {}),
  };
}

/**
 * §4.1 — synthesize the `mcp_servers.thredz` stdio entry from an `IrThredz`.
 * Env values are `IrSecretRef`s riding the §4.2 secret machinery end-to-end:
 * the key stays out of compiled artifacts, `collectSecretRefs` lists
 * `THREDZ_API_KEY` in the generated README automatically, and emitted
 * bundles resolve it at boot via `resolveMcpServerConfig` (fail-fast with
 * the variable's name when unset).
 */
function synthesizeThredzServer(thredz: IrThredz): IrMcpServerConfig {
  return {
    transport: "stdio",
    command: "npx",
    args: ["-y", THREDZ_MCP_PACKAGE_SPEC],
    env: {
      THREDZ_API_KEY: thredz.apiKey,
      ...(thredz.baseUrl !== undefined
        ? { THREDZ_API_BASE: { kind: "literal", value: thredz.baseUrl } }
        : {}),
      // Deterministic visibility enforcement (§4.3): never left to the
      // server's own default, even though thredz-mcp v0.2.0 also defaults
      // private.
      THREDZ_DEFAULT_VISIBILITY: { kind: "literal", value: thredz.visibility },
      // 0.5.0 — scope every wiki call to one space. Deterministic, exactly like
      // visibility: the server would otherwise fall back to the unspaced legacy
      // wiki. Omitted entirely when no space is declared, so unspaced bundles
      // stay byte-identical to 0.4.x.
      ...(thredz.space !== undefined
        ? { THREDZ_DEFAULT_SPACE: { kind: "literal", value: thredz.space } }
        : {}),
    },
  };
}

/**
 * The emit-WIRED lowering (cli shape): resolve the block, synthesize the MCP
 * server (unless the user declared their own `mcp_servers.thredz` — explicit
 * beats implicit; `crewhaus lint` warns about the shadowing), and flip
 * `memory.backend` to `thredz` on a declared memory block. Cross-field
 * validation lives here (LOAD-BEARING — these thredz rules have no
 * ir-passes mirror, so lower time is their only gate):
 *   - `memory.backend: thredz` without the `thredz:` block is an error (the
 *     backend needs the API key the block carries);
 *   - `memory.backend: file` alongside `thredz:` is a contradiction.
 */
function lowerThredzWired(
  spec: SpecWithThredz,
  opts: {
    readonly continuityGoalsOn: boolean;
    readonly mcpServers: IrMcpServers;
    readonly memory: { memory?: IrMemory };
  },
): { thredz?: IrThredz; mcp_servers: IrMcpServers; memory?: IrMemory } {
  const thredz = lowerThredzBlock(spec, opts.continuityGoalsOn);
  if (thredz === undefined) {
    if (spec.memory?.backend === "thredz") {
      throw new CompilerError(
        `memory.backend "thredz" needs the top-level thredz: block (it carries the API key) — add \`thredz: $THREDZ_API_KEY\`, or drop the backend override to stay on local files.`,
      );
    }
    return { mcp_servers: opts.mcpServers, ...opts.memory };
  }
  if (spec.memory?.backend === "file") {
    throw new CompilerError(
      `memory.backend "file" contradicts the thredz: block — the one knob flips the wiki backend to Thredz (design §4). Drop the backend override (or remove thredz:) and recompile.`,
    );
  }
  const userDeclared = opts.mcpServers[THREDZ_MCP_SERVER_NAME] !== undefined;
  const mcpServers = userDeclared
    ? opts.mcpServers
    : (Object.freeze({
        ...opts.mcpServers,
        [THREDZ_MCP_SERVER_NAME]: synthesizeThredzServer(thredz),
      }) as IrMcpServers);
  const memory =
    opts.memory.memory !== undefined
      ? { memory: { ...opts.memory.memory, backend: "thredz" as const } }
      : {};
  return { thredz, mcp_servers: mcpServers, ...memory };
}

/**
 * Loop contract 0.4 (Batch E, G23) — the emit-wired thredz lowering for the
 * MANAGED shape, which has NO `mcp_servers` field. Same resolve + memory-
 * backend-flip + cross-field validation as {@link lowerThredzWired}, but it
 * synthesizes no mcp_servers entry: the managed daemon builds the thredz
 * stdio server from `IrThredz` itself and boots connectThredz (it cannot
 * fold the server into a non-existent mcp_servers map). The `memory.backend`
 * rules are identical to the cli/channel path.
 */
function lowerThredzWiredNoMcp(
  spec: SpecWithThredz,
  opts: { readonly continuityGoalsOn: boolean; readonly memory: { memory?: IrMemory } },
): { thredz?: IrThredz; memory?: IrMemory } {
  const thredz = lowerThredzBlock(spec, opts.continuityGoalsOn);
  if (thredz === undefined) {
    if (spec.memory?.backend === "thredz") {
      throw new CompilerError(
        `memory.backend "thredz" needs the top-level thredz: block (it carries the API key) — add \`thredz: $THREDZ_API_KEY\`, or drop the backend override to stay on local files.`,
      );
    }
    return { ...opts.memory };
  }
  if (spec.memory?.backend === "file") {
    throw new CompilerError(
      `memory.backend "file" contradicts the thredz: block — the one knob flips the wiki backend to Thredz (design §4). Drop the backend override (or remove thredz:) and recompile.`,
    );
  }
  const memory =
    opts.memory.memory !== undefined
      ? { memory: { ...opts.memory.memory, backend: "thredz" as const } }
      : {};
  return { thredz, ...memory };
}

/**
 * The CARRIED lowering (research/crew): the block parses and lowers to
 * `IrThredz` so recompiles round-trip, but nothing is synthesized or flipped
 * — those emitters print the 0.2.3-convention ignored-note comment instead of
 * half-wiring a backend their daemons cannot boot yet. (cli/channel/managed
 * are now emit-WIRED — see {@link lowerThredzWired} / {@link
 * lowerThredzWiredNoMcp}.) An explicit `memory.backend: thredz` is rejected
 * loudly (dead config that would degrade-warn every run beats nobody's use
 * case).
 */
/**
 * 0.5.0 — the deterministic `mcp_servers` key for a role that overrides the
 * crew-wide Thredz config.
 *
 * Hyphen, never ":" — a role name may legally contain spaces, dots and colons
 * (`safeName` is permissive), and if the server name ever falls through to
 * `namespacedToolName` it builds `<server>__<tool>`, which must satisfy the
 * providers' `^[a-zA-Z0-9_-]{1,64}$`. The spec layer already rejects two roles
 * whose names collapse to the same slug, so this cannot silently collide.
 */
function thredzServerNameForRole(role: string): string {
  const slug = role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") {
    throw new CompilerError(
      `thredz.roles[${JSON.stringify(role)}]: the role name has no characters usable in an MCP server name — rename the role.`,
    );
  }
  return `${THREDZ_MCP_SERVER_NAME}-${slug}`;
}

/**
 * 0.5.0 — emit-wired Thredz for the crew shape, with the per-role fan-out.
 *
 * One Thredz API key owns at most ONE individual (private) wiki space, and
 * `thredz-mcp` reads exactly one key per process. So per-role private memory
 * is per-role keys is per-role SERVER PROCESSES — this function resolves each
 * role's config and assigns it a server name, and the emitter spawns one npx
 * child per distinct name.
 *
 * Roles that do not override the crew-wide block share the single `"thredz"`
 * server, and therefore share one key, one space and one process. That is the
 * right default: a crew with one brain is the common case.
 */
function lowerThredzWiredCrew(
  spec: SpecWithThredz & { readonly roles: Readonly<Record<string, unknown>> },
  opts: {
    readonly continuityGoalsOn: boolean;
    readonly mcpServers: IrMcpServers;
    readonly memory: { memory?: IrMemory };
  },
): {
  thredz?: IrThredz;
  mcp_servers: IrMcpServers;
  memory?: IrMemory;
  roleThredz: ReadonlyMap<string, { thredz: IrThredz; server: string }>;
} {
  const block = spec.thredz;
  const fanOut =
    typeof block === "object" && block !== null && block.roles !== undefined
      ? block.roles
      : undefined;
  const hasFanOut = fanOut !== undefined && Object.keys(fanOut).length > 0;

  // The crew-wide default. `roles` is stripped first — `lowerThredzBlock`
  // reads the strict object shape and must not see the fan-out map.
  const crewDefaultSpec: SpecWithThredz = {
    ...spec,
    ...(typeof block === "object" && block !== null
      ? {
          thredz: Object.fromEntries(
            Object.entries(block).filter(([k]) => k !== "roles"),
          ) as SpecThredz,
        }
      : {}),
  };
  const hasCrewKey = typeof block !== "object" || block === null || block.api_key !== undefined;
  const crewDefault = hasCrewKey
    ? lowerThredzBlock(crewDefaultSpec, opts.continuityGoalsOn)
    : undefined;

  if (crewDefault === undefined && !hasFanOut) {
    if (spec.memory?.backend === "thredz") {
      throw new CompilerError(
        `memory.backend "thredz" needs the top-level thredz: block (it carries the API key) — add \`thredz: $THREDZ_API_KEY\`, or drop the backend override to stay on local files.`,
      );
    }
    return { mcp_servers: opts.mcpServers, ...opts.memory, roleThredz: new Map() };
  }
  if (spec.memory?.backend === "file") {
    throw new CompilerError(
      `memory.backend "file" contradicts the thredz: block — the one knob flips the wiki backend to Thredz (design §4). Drop the backend override (or remove thredz:) and recompile.`,
    );
  }

  // Resolve every role. A role with an override gets its own server; a role
  // without one rides the crew default (when there is one).
  const roleThredz = new Map<string, { thredz: IrThredz; server: string }>();
  const defaults =
    typeof block === "object" && block !== null
      ? Object.fromEntries(Object.entries(block).filter(([k]) => k !== "roles" && k !== "api_key"))
      : {};
  for (const roleName of Object.keys(spec.roles).sort((a, b) => a.localeCompare(b))) {
    const override = fanOut?.[roleName];
    if (override === undefined) {
      if (crewDefault !== undefined) {
        roleThredz.set(roleName, { thredz: crewDefault, server: THREDZ_MCP_SERVER_NAME });
      }
      continue;
    }
    // Field-by-field merge, so an override omitting `visibility` inherits it.
    // The merged object goes back through `lowerThredzBlock` so credential
    // lowering, the visibility default and `agents: true` handle derivation
    // all happen in exactly one place. The derived handle is per-role, or two
    // roles would race for the same Thredz agent handle.
    const merged = {
      ...defaults,
      ...Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined)),
      api_key:
        override.api_key ??
        (typeof block === "object" && block !== null ? block.api_key : undefined),
    } as Exclude<SpecThredz, boolean | string>;
    const resolved = lowerThredzBlock(
      { ...spec, name: `${spec.name}-${roleName}`, thredz: merged },
      opts.continuityGoalsOn,
    );
    if (resolved === undefined) continue;
    roleThredz.set(roleName, { thredz: resolved, server: thredzServerNameForRole(roleName) });
  }

  // The continuity goal mirror is singular and the continuity store is
  // spec-scoped and SHARED by every role. Mirroring one crew plan into N
  // private spaces has no correct semantics, so the mirror rides the crew
  // default only. A pure fan-out crew gets it forced off rather than failing
  // to compile, because `goals` defaults to `continuityGoalsOn`.
  const goalMirrorHomeless = crewDefault === undefined;
  const finalRoleThredz = goalMirrorHomeless
    ? new Map(
        [...roleThredz].map(([name, entry]) => [
          name,
          { ...entry, thredz: { ...entry.thredz, goals: false } },
        ]),
      )
    : roleThredz;

  // One synthesized entry per DISTINCT server name, and the
  // explicit-beats-implicit check is asked PER KEY — asking it once against
  // the bare "thredz" name would let a user-declared override of one role's
  // server suppress every other role's.
  let mcpServers = opts.mcpServers;
  const synthesized: Record<string, IrMcpServerConfig> = {};
  for (const [, entry] of finalRoleThredz) {
    if (opts.mcpServers[entry.server] !== undefined) continue;
    if (synthesized[entry.server] !== undefined) continue;
    synthesized[entry.server] = synthesizeThredzServer(entry.thredz);
  }
  if (Object.keys(synthesized).length > 0) {
    mcpServers = Object.freeze({ ...opts.mcpServers, ...synthesized }) as IrMcpServers;
  }

  const memory =
    opts.memory.memory !== undefined
      ? { memory: { ...opts.memory.memory, backend: "thredz" as const } }
      : {};

  return {
    ...(crewDefault !== undefined ? { thredz: crewDefault } : {}),
    mcp_servers: mcpServers,
    ...memory,
    roleThredz: finalRoleThredz,
  };
}

function lowerThredzCarried(
  spec: SpecWithThredz,
  continuityGoalsOn: boolean,
  shape: string,
): { thredz?: IrThredz } {
  if (spec.memory?.backend === "thredz") {
    throw new CompilerError(
      `memory.backend "thredz" is emit-wired on cli/channel/managed/crew in this release — the ${shape} shape carries the thredz: block for forward compatibility but keeps the local backend. Remove the backend override.`,
    );
  }
  const thredz = lowerThredzBlock(spec, continuityGoalsOn);
  return thredz !== undefined ? { thredz } : {};
}

// ---------------------------------------------------------------------------
// v0.3.0 Goal 2 (§3.3, PR 17) — the `learning:` block, lowered here.
// ---------------------------------------------------------------------------

type SpecWithLearning = {
  readonly learning?: {
    readonly enabled?: boolean;
    readonly domain: string;
    readonly curriculum?: string;
    readonly sources?: readonly string[];
    readonly exam?: { readonly dataset: string; readonly graders: string };
    readonly study?: { readonly on_heartbeat?: boolean; readonly on_dream?: boolean };
  };
  readonly memory?: {
    readonly wiki?: { readonly enabled?: boolean; readonly requireSources?: boolean };
  };
  readonly thredz?: SpecThredz;
};

/**
 * Lower the `learning:` block to a RESOLVED `IrLearning` (study toggles
 * defaulted to true so downstream reads one deterministic shape). Cross-field
 * validation lives HERE (LOAD-BEARING — the first line, with the better
 * message), mirrored by ir-passes' `memoryIntegrityPass` (G45: now also run
 * unconditionally inside compile()) for direct-IR builders:
 *
 *   - learning NEEDS a wiki (the knowledge lives there): `memory.wiki`
 *     (local, not explicitly disabled) or `thredz:` (hosted) must be present;
 *   - an explicit `memory.wiki.requireSources: false` contradicts learning's
 *     deterministic Sources-required write governance (§3.3) — rejected
 *     loudly rather than silently overridden.
 *
 * Whether `curriculum`/`exam.dataset`/`exam.graders` files EXIST is a
 * RUNTIME concern (the study/exam paths fail with clear errors); the
 * compiler validates shape only.
 */
function lowerLearning(spec: SpecWithLearning): { learning?: IrLearning } {
  const l = spec.learning;
  if (l === undefined || l.enabled === false) return {};

  const wikiOn = spec.memory?.wiki !== undefined && spec.memory.wiki.enabled !== false;
  const thredzOn = spec.thredz !== undefined && spec.thredz !== false;
  if (!wikiOn && !thredzOn) {
    throw new CompilerError(
      "learning: needs a wiki to learn into — enable the local one (memory: { wiki: { enabled: true } }) or add the hosted backend (thredz: $THREDZ_API_KEY). The learning loop commits knowledge to wiki articles, not to the prompt.",
    );
  }
  if (spec.memory?.wiki?.requireSources === false) {
    throw new CompilerError(
      "memory.wiki.requireSources: false contradicts the learning: block — learning enforces Sources-required wiki writes deterministically (design §3.3: no source, no commit). Drop the override (or remove learning:) and recompile.",
    );
  }

  return {
    learning: {
      domain: l.domain,
      ...(l.curriculum !== undefined ? { curriculum: l.curriculum } : {}),
      ...(l.sources !== undefined ? { sources: [...l.sources] } : {}),
      ...(l.exam !== undefined
        ? { exam: { dataset: l.exam.dataset, graders: l.exam.graders } }
        : {}),
      // Resolved defaults: unattended study is ON for a learning harness —
      // the block itself is the opt-in; the toggles are the opt-outs.
      study: {
        onHeartbeat: l.study?.on_heartbeat ?? true,
        onDream: l.study?.on_dream ?? true,
      },
    },
  };
}

/**
 * §3.3 write-path governance, applied at lower time: with learning ON,
 * `memory.wiki.requireSources` is stamped `true` on the lowered memory block
 * so `wiki_write` deterministically rejects bodies without a `## Sources`
 * heading (the contradiction — an explicit `false` — was rejected in
 * `lowerLearning`). No learning, or no local wiki block (thredz-only), and
 * the lowered memory passes through untouched — byte-identical IR.
 */
function applyLearningWikiGovernance(
  lowered: { memory?: IrMemory },
  learningOn: boolean,
): { memory?: IrMemory } {
  if (!learningOn || lowered.memory?.wiki === undefined) return lowered;
  return {
    memory: {
      ...lowered.memory,
      wiki: { ...lowered.memory.wiki, requireSources: true },
    },
  };
}

type SpecWithObservability = { readonly observability?: SpecObservabilityBlock };

/**
 * Ops item 37 + Loop contract 0.4 (Batch C, G26) — lower the cross-cutting
 * `observability` block, mirroring lowerMemory's spread-return-{} discipline
 * (Pillar 1): the key is absent from the IR when the spec omits the block.
 *
 * `slo.window_seconds` is folded to `windowMs` (ms) at lower time so the
 * runtime monitor reads a literal duration; `mitigation` defaults to
 * `["alert"]` here so an observe-only spec that lists thresholds without a
 * ladder still warns (the safe rung). Targets are carried verbatim from
 * snake_case spec keys to camelCase IR keys.
 *
 * G26 DEFAULTS SEMANTICS — spec ABSENCE is NOT `off`. This lowering carries
 * ONLY the sub-blocks the spec declares; an absent sub-block stays absent from
 * the IR and the EMITTER applies the default (cost-tracker + ring buffer ON;
 * metrics/alerts/incidents opt-in OFF). An explicit `cost: { enabled: false }`
 * / `trace: { level: "off" }` reaches the IR verbatim and wins. Zod has
 * already materialised each declared toggle's `enabled` default (`true`) and
 * `trace.level`'s default (`"ring"`), so a bare `metrics: {}` lowers to
 * `{ enabled: true }`.
 */
function lowerObservability(spec: SpecWithObservability): { observability?: IrObservability } {
  const o = spec.observability;
  if (o === undefined) return {};
  const observability: { -readonly [K in keyof IrObservability]: IrObservability[K] } = {};
  const slo = o.slo;
  if (slo !== undefined) {
    observability.slo = {
      ...(slo.error_rate !== undefined ? { errorRate: slo.error_rate } : {}),
      ...(slo.p95_latency_ms !== undefined ? { p95LatencyMs: slo.p95_latency_ms } : {}),
      ...(slo.ttft_ms !== undefined ? { ttftMs: slo.ttft_ms } : {}),
      ...(slo.cost_per_hour_usd !== undefined ? { costPerHourUsd: slo.cost_per_hour_usd } : {}),
      ...(slo.egress_block_rate !== undefined ? { egressBlockRate: slo.egress_block_rate } : {}),
      ...(slo.window_seconds !== undefined ? { windowMs: slo.window_seconds * 1000 } : {}),
      mitigation: slo.mitigation !== undefined ? [...slo.mitigation] : ["alert"],
    };
  }
  if (o.trace !== undefined) observability.trace = { level: o.trace.level };
  if (o.metrics !== undefined) observability.metrics = { enabled: o.metrics.enabled };
  if (o.cost !== undefined) observability.cost = { enabled: o.cost.enabled };
  if (o.alerts !== undefined) observability.alerts = { enabled: o.alerts.enabled };
  if (o.incidents !== undefined) observability.incidents = { enabled: o.incidents.enabled };
  if (o.otel !== undefined) {
    observability.otel = o.otel.endpoint !== undefined ? { endpoint: o.otel.endpoint } : {};
  }
  return { observability };
}

type SpecWithWatchme = { readonly watchme?: SpecWatchmeBlock };

/**
 * "Watch me" (design/watch-me.md §4.6) — lower the `watchme:` block on its
 * three carrier shapes (cli/channel/managed), with the spread-return-{}
 * discipline: an absent block spreads NOTHING, so watchme-less specs compile
 * byte-identically. Unlike lowerObservability's declare-only carriage, the
 * IR block is fully populated here: zod has already materialised the
 * top-level defaults, and the OPTIONAL `judge:` sub-block's defaults resolve
 * now (`claude-haiku-4-5` / 0.15 / 0 — matching the spec schema's own
 * defaults when `judge: {}` is declared), so emitters/runtimes never
 * re-derive them.
 */
function lowerWatchme(spec: SpecWithWatchme, ctx: LowerContext): { watchme?: IrWatchme } {
  const w = spec.watchme;
  if (w === undefined) return {};
  // 0.6.0 §4.3 — the judge model is an auxiliary slot (it used to be baked
  // verbatim, so `$profile` / `cheapest` / `strongest` never resolved here).
  // The schema-matching default keeps a profile-less spec byte-identical.
  const judge = resolveAuxSlot(w.judge?.model ?? "claude-haiku-4-5", ctx, "watchme.judge.model");
  return {
    watchme: {
      enabled: w.enabled,
      capture: w.capture,
      judgeModel: judge.model,
      ...(judge.modelProfile !== undefined ? { judgeProfile: judge.modelProfile } : {}),
      ...(judge.params !== undefined ? { judgeParams: judge.params } : {}),
      judgeSampleRate: w.judge?.sample_rate ?? 0.15,
      judgeBudgetUsd: w.judge?.budget_usd ?? 0,
      scope: w.scope,
      share: w.share,
    },
  };
}

/**
 * Section 47 — normalise the cross-cutting blockchain subsystem blocks
 * (chains / wallets / contracts / transaction_policy). Each block is
 * optional; the helper returns a partial that's spread into the IR
 * variant, so unused blocks remain absent (Pillar 1: emitters check
 * presence and skip chain init when none are declared).
 *
 * `rpcUrls` and `keyRef` strings are routed through `lowerSecret` so
 * `$ALCHEMY_URL` / `$KMS_KEY_ID` become env-var references at runtime
 * — the bundle never embeds RPC credentials or signing keys.
 *
 * Validation that's not expressible in Zod (cross-block references —
 * `wallets[*].chainId` must reference declared `chains[*].id`,
 * `transaction_policy.allowed_contracts` must reference declared
 * `contracts[*].id`) is enforced by the §47 IR pass in `ir-passes`
 * (slice 1). At the compiler layer we just pass values through.
 */
type SpecChainSubsystem = {
  readonly chains?: ReadonlyArray<{
    readonly id: string;
    readonly kind: "evm";
    readonly rpcUrls: readonly string[];
    readonly rpcPolicy: "single" | "quorum" | "fallback";
    readonly finality:
      | { readonly kind: "confirmations"; readonly count: number }
      | { readonly kind: "finalized" }
      | { readonly kind: "safe" };
    readonly reorgTolerant: boolean;
  }>;
  readonly wallets?: ReadonlyArray<{
    readonly id: string;
    readonly chainId: string;
    readonly custody: "user-controlled" | "kms" | "hsm" | "local";
    readonly signingPolicy: "explicit-user-approval" | "policy-gated" | "automated";
    readonly keyRef?: string;
  }>;
  readonly contracts?: ReadonlyArray<{
    readonly id: string;
    readonly chainId: string;
    readonly address: string;
    readonly abiRef: string;
  }>;
  readonly transaction_policy?: {
    readonly defaultWriteApproval: "required" | "policy" | "none";
    readonly maxValueUsd?: number;
    readonly maxValueWei?: string;
    readonly allowedContracts: readonly string[];
    readonly simulationRequired: boolean;
  };
};

type IrChainSubsystem = {
  chains?: readonly IrChainBinding[];
  wallets?: readonly IrWalletBinding[];
  contracts?: readonly IrContractBinding[];
  transactionPolicy?: IrTransactionPolicy;
};

function lowerChainFinality(
  f: NonNullable<SpecChainSubsystem["chains"]>[number]["finality"],
): IrChainFinality {
  if (f.kind === "confirmations") return { kind: "confirmations", count: f.count };
  if (f.kind === "finalized") return { kind: "finalized" };
  return { kind: "safe" };
}

function lowerChainSubsystem(spec: SpecChainSubsystem): IrChainSubsystem {
  const out: IrChainSubsystem = {};
  if (spec.chains !== undefined) {
    out.chains = spec.chains.map((c) => ({
      id: c.id,
      kind: c.kind,
      rpcUrls: c.rpcUrls.map(lowerSecret),
      rpcPolicy: c.rpcPolicy,
      finality: lowerChainFinality(c.finality),
      reorgTolerant: c.reorgTolerant,
    }));
  }
  if (spec.wallets !== undefined) {
    out.wallets = spec.wallets.map((w) => ({
      id: w.id,
      chainId: w.chainId,
      custody: w.custody,
      signingPolicy: w.signingPolicy,
      ...(w.keyRef !== undefined ? { keyRef: lowerWalletKeyRef(w.id, w.keyRef) } : {}),
    }));
  }
  if (spec.contracts !== undefined) {
    out.contracts = spec.contracts.map((ct) => ({
      id: ct.id,
      chainId: ct.chainId,
      address: ct.address,
      abiRef: ct.abiRef,
    }));
  }
  if (spec.transaction_policy !== undefined) {
    const tp = spec.transaction_policy;
    out.transactionPolicy = {
      defaultWriteApproval: tp.defaultWriteApproval,
      ...(tp.maxValueUsd !== undefined ? { maxValueUsd: tp.maxValueUsd } : {}),
      ...(tp.maxValueWei !== undefined ? { maxValueWei: tp.maxValueWei } : {}),
      allowedContracts: [...tp.allowedContracts],
      simulationRequired: tp.simulationRequired,
    };
  }
  return out;
}

/**
 * Phase 3 §47 — validate that the onchain-game subsystem lowering produced a
 * chain, wallet, and contract, returning them as a non-optional triple.
 * lower() builds single-element input arrays, so in the normal flow these are
 * always present; this guard documents that precondition and is exported so
 * the direct-call surface (callers that build IR via lower()/this helper
 * rather than through parseSpec) gets a precise, typed failure instead of an
 * opaque `undefined` slipping into the IR.
 */
export function assertChainGameLowered(
  chain: IrChainBinding | undefined,
  wallet: IrWalletBinding | undefined,
  contract: IrContractBinding | undefined,
): { chain: IrChainBinding; wallet: IrWalletBinding; contract: IrContractBinding } {
  if (chain === undefined || wallet === undefined || contract === undefined) {
    throw new CompilerError("onchain-game lowering failed to produce chain/wallet/contract");
  }
  return { chain, wallet, contract };
}

/**
 * 0.6.0 §4.3 — the serving agent slot of an agent-carrying shape: resolve
 * `agent.model` (a `$profile`, a sentinel, or a grammar string), apply the
 * profile per the shape's {@link SingleSlotKind}, and report a slot
 * `temperature` as pending until the plan table applies it.
 */
function resolveServingAgent(
  agent: {
    readonly model: string;
    readonly thinking?: SpecThinking;
    readonly max_tokens?: number;
    readonly temperature?: number;
    readonly model_pool?: unknown;
    readonly model_tiers?: unknown;
    readonly model_fallbacks?: unknown;
  },
  ctx: LowerContext,
  kind: SingleSlotKind,
  path = "agent",
): SingleSlotResult {
  const slot = applyProfileToSlot(
    resolveModelRef(agent.model, ctx, `${path}.model`),
    ctx,
    `${path}.model`,
    kind,
    {
      ...lowerThinking(agent.thinking),
      ...(agent.max_tokens !== undefined ? { maxTokens: agent.max_tokens } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      hasRouting:
        agent.model_pool !== undefined ||
        agent.model_tiers !== undefined ||
        agent.model_fallbacks !== undefined,
    },
  );
  return slot;
}

/** The `models` registry field, present only when the spec declared one. */
function registryField(ctx: LowerContext): { models?: IrModelProfiles } {
  return ctx.hasRegistry ? { models: ctx.registry } : {};
}

/**
 * 0.6.0 §4.3 — the judge-independence lint: on a spec that opted into the
 * 0.6.0 surface (a `models:` registry or a pool `strategy`), warn when an
 * EXPLICITLY declared judge model (or panel member) is the SAME model as an
 * arm it grades (the serving agent, a pool candidate, or — for a `kind:
 * judge` step/node — the gated block's). The compiler-chosen default
 * (`strongest`, see {@link defaultJudgeSlot}) is never reported — a warning
 * about a default the compiler itself picked would be unactionable.
 * `evaluation.allow_self_judge: true` silences it. A 0.5.x-shaped
 * self-judging pooled spec stays warning-free, so nothing that compiled
 * quietly before compiles noisily now.
 */
function specDeclaresStrategy(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(specDeclaresStrategy);
  const block = asLooseBlock(value);
  if (block === undefined) return false;
  if (asLooseBlock(block["model_pool"])?.["strategy"] !== undefined) return true;
  return Object.values(block).some(specDeclaresStrategy);
}

function noteSelfJudge(spec: Spec, ir: IrNode, ctx: LowerContext): void {
  if (!ctx.optedIn) return;
  const s = spec as unknown as LooseBlock;
  /** TRUE when the spec itself names the judge model at `block.judge.model` / `grader.model`. */
  const declaredJudge = (block: unknown, key: "judge" | "grader"): boolean =>
    asLooseBlock(asLooseBlock(block)?.[key])?.["model"] !== undefined;
  const arms = (block: {
    readonly model: string;
    readonly modelPool?: IrModelPool;
    readonly modelTiers?: IrModelTiers;
  }): Set<string> => {
    const out = new Set<string>([block.model]);
    for (const c of block.modelPool?.candidates ?? []) out.add(c.model);
    if (block.modelTiers !== undefined) {
      out.add(block.modelTiers.fast);
      out.add(block.modelTiers.default);
    }
    return out;
  };
  const report = (path: string, judgeModel: string, gated: string): void =>
    warn(
      ctx,
      "model-plan-self-judge",
      path,
      `${path}: the judge model "${judgeModel}" is also ${gated} — a model grading its own output is a measurement-integrity hazard; point the judge at a stronger, independent model (or set allow_self_judge: true to accept it)`,
    );
  if (ir.target === "cli" || ir.target === "channel" || ir.target === "managed") {
    const ev = ir.evaluation;
    if (ev === undefined || ev.grader.type !== "llm_judge" || ev.allowSelfJudge === true) return;
    const serving = arms(ir.agent);
    const explicit = declaredJudge(s["evaluation"], "grader")
      ? [ev.grader.model ?? ir.agent.model]
      : [];
    const judges = [...explicit, ...(ev.grader.judges ?? [])];
    for (const judgeModel of judges) {
      if (serving.has(judgeModel)) {
        report("evaluation.grader.model", judgeModel, "a serving arm of agent.model / model_pool");
        return;
      }
    }
    return;
  }
  if (ir.target === "workflow") {
    ir.steps.forEach((step, i) => {
      if (step.kind !== "judge") return;
      const gated = ir.steps[i - 1];
      if (gated === undefined || gated.kind === "judge") return;
      const serving = arms(gated);
      const specSteps = Array.isArray(s["steps"]) ? s["steps"] : [];
      const explicit = declaredJudge(specSteps[i], "judge") ? [step.model] : [];
      for (const judgeModel of [...explicit, ...(step.judge?.judges ?? [])]) {
        if (serving.has(judgeModel)) {
          report(
            `steps[${i}].judge.model`,
            judgeModel,
            `a serving arm of the gated step "${gated.name}"`,
          );
          return;
        }
      }
    });
    return;
  }
  if (ir.target === "graph") {
    const byName = new Map(ir.nodes.map((n) => [n.name, n]));
    for (const node of ir.nodes) {
      if (node.kind !== "judge") continue;
      const upstream = ir.edges.filter((e) => e.to === node.name).map((e) => byName.get(e.from));
      for (const gated of upstream) {
        if (gated === undefined || gated.kind === "judge") continue;
        const serving = arms(gated);
        const explicit = declaredJudge(asLooseBlock(s["nodes"])?.[node.name], "judge")
          ? [node.model]
          : [];
        for (const judgeModel of [...explicit, ...(node.judge?.judges ?? [])]) {
          if (serving.has(judgeModel)) {
            report(
              `nodes.${node.name}.judge.model`,
              judgeModel,
              `a serving arm of the gated node "${gated.name}"`,
            );
            return;
          }
        }
      }
    }
  }
}

/**
 * Lower a parsed spec to its IR variant AND return the compile warnings the
 * lowering produced (0.6.0: the field-precise model-plan notices, sunset and
 * capability notes). `compile()` merges them with the spec-level warnings;
 * `lower()` is the same pipeline minus the warnings.
 */
export function lowerWithWarnings(
  spec: Spec,
  opts: LowerOptions = {},
): { readonly ir: IrNode; readonly warnings: ReadonlyArray<CompileWarning> } {
  // 0.6.0 PR 7 — the narrowing knobs whose runtime consumer has not landed
  // are refused loudly and path-precisely (see the §4.3 section header);
  // everything else in the §11.1 delta lowers. Absent ⇒ byte-identical.
  if (opts.allowRuntimePendingKeys !== true) assertNoRuntimePendingKeys(spec);
  const ctx = createLowerContext(spec, opts);
  const ir = lowerWithContext(spec, ctx);
  noteSelfJudge(spec, ir, ctx);
  return { ir, warnings: ctx.warnings };
}

export function lower(spec: Spec, opts: LowerOptions = {}): IrNode {
  return lowerWithWarnings(spec, opts).ir;
}

function lowerWithContext(spec: Spec, ctx: LowerContext): IrNode {
  switch (spec.target) {
    case "cli": {
      // v0.3.0 Goal 1 — DEFAULT-ON continuity (the release's one sanctioned
      // behavior change): absent lowers to the default-on config;
      // `continuity: false` restores prior bytes exactly.
      const continuity = lowerContinuity(spec, { defaultOn: true, autoScope: "spec" });
      // v0.3.0 Goal 3 — the `thredz:` knob, emit-WIRED on this shape:
      // synthesizes `mcp_servers.thredz` (user-declared wins) and flips a
      // declared memory block's backend. No thredz block ⇒ both pass
      // through unchanged (byte-identical bundles).
      const thredzLowered = lowerThredzWired(spec, {
        continuityGoalsOn: continuity.continuity?.plan === true,
        mcpServers: lowerMcpServers(spec.mcp_servers),
        memory: lowerMemory(spec),
      });
      // v0.3.0 Goal 2 — the `learning:` block (validated against the wiki/
      // thredz surface it needs) + the §3.3 Sources-required wiki stamp.
      const learning = lowerLearning(spec);
      const memoryLowered = applyLearningWikiGovernance(
        thredzLowered.memory !== undefined ? { memory: thredzLowered.memory } : {},
        learning.learning !== undefined,
      );
      // 0.6.0 §4.3 — the serving slot resolves through the registry.
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-full");
      return {
        version: 0,
        name: spec.name,
        target: "cli",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          // 0.6.0 §4.3 — params (declared, or the profile's) + provenance;
          // Loop contract 0.4 (Batch A) — streaming / rate limits.
          ...servingSlotFields(agentSlot),
          ...(spec.agent.streaming !== undefined ? { streaming: spec.agent.streaming } : {}),
          ...lowerRateLimits(spec.agent.rate_limits),
          ...lowerModelFailover(spec.agent, ctx, "agent"),
          ...servingSlotFailover(agentSlot),
        },
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: thredzLowered.mcp_servers,
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents, ctx, "agent"),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
        ...lowerEvaluation(spec, ctx),
        ...lowerSecurity(spec, ctx),
        ...lowerFeedback(spec),
        ...memoryLowered,
        // Loop contract 0.4 (Batch E, G22) — agent-shape RAG over doc sources.
        ...lowerKnowledge(spec),
        ...continuity,
        ...(thredzLowered.thredz !== undefined ? { thredz: thredzLowered.thredz } : {}),
        ...learning,
        ...lowerObservability(spec),
        // "Watch me" — observe-and-learn (sibling of observability, §4.6).
        ...lowerWatchme(spec, ctx),
        // Batch G — MCP-server projection (G30) + plugin activation (G32).
        ...lowerExpose(spec),
        ...lowerPlugins(spec),
        // Phase 3 §3.3 — CLI banner config. Plus Phase 2 M2.2 TUI mode
        // gate. Only included when the spec author opted in (cli block
        // and its fields are optional).
        ...(spec.cli !== undefined
          ? {
              cli: {
                ...(spec.cli.banner !== undefined
                  ? {
                      banner: {
                        taglineMode: spec.cli.banner.taglineMode,
                        taglines: [...spec.cli.banner.taglines],
                      },
                    }
                  : {}),
                // Loop contract 0.4 (Batch F, G81) — `cli.tui` is now a
                // single-valued `"basic"` (the never-implemented `"rich"` is
                // rejected at parse time), so there is nothing left to lower.
              },
            }
          : {}),
        ...lowerChainSubsystem(spec),
      } satisfies IrV0;
    }
    case "workflow": {
      // 0.6.0 §4.3 — the top-level `model` slot resolves once; a step without
      // its own `model` inherits the resolved slot AND its profile.
      const topRef = resolveModelRef(spec.model, ctx, "model");
      return {
        version: 0,
        name: spec.name,
        target: "workflow",
        ...registryField(ctx),
        steps: spec.steps.map((s, i) => {
          // Loop contract 0.4 (Batch B, G02) — judge gate steps run no agent
          // turn of their own: instructions carry the criteria verbatim, the
          // judge model resolves into the ordinary `model` slot
          // (`judge.model ?? workflow.model`, an auxiliary slot), and the
          // gate knobs resolve in `lowerJudgeGate`. `kind` exists ONLY on
          // the judge variant, so the `in` check is the discriminator.
          if ("kind" in s) {
            const judgeSlot =
              s.judge.model !== undefined
                ? resolveAuxSlot(s.judge.model, ctx, `steps[${i}].judge.model`)
                : defaultJudgeSlot(ctx, `steps[${i}].judge.model`);
            return {
              name: s.name,
              kind: "judge" as const,
              instructions: s.judge.criteria,
              model: judgeSlot?.model ?? topRef.model,
              tools: [],
              toolConfigs: lowerToolConfigs(undefined),
              judge: lowerJudgeGate(s.judge, judgeSlot, ctx, `steps[${i}].judge`),
            };
          }
          const slotPath = s.model !== undefined ? `steps[${i}].model` : "model";
          const slot = applyProfileToSlot(
            s.model !== undefined ? resolveModelRef(s.model, ctx, slotPath) : topRef,
            ctx,
            slotPath,
            "agent-full",
            {
              ...lowerThinking(s.thinking),
              ...(s.max_tokens !== undefined ? { maxTokens: s.max_tokens } : {}),
              ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
              hasRouting:
                s.model_pool !== undefined ||
                s.model_tiers !== undefined ||
                s.model_fallbacks !== undefined,
            },
          );
          return {
            name: s.name,
            instructions: foldOverlay(s.instructions, slot.overlay),
            model: slot.model,
            ...servingSlotFields(slot),
            tools: s.tools ?? [],
            toolConfigs: lowerToolConfigs(s.tool_config),
            // Item 9 (G37) — per-step model routing (failover/tiers/pool),
            // reusing the cli agent block's lowering verbatim.
            ...lowerModelFailover(s, ctx, `steps[${i}]`),
            ...servingSlotFailover(slot),
          };
        }),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
        ...lowerChainSubsystem(spec),
      } satisfies IrWorkflowV0;
    }
    case "channel": {
      const continuity = lowerContinuity(spec, { defaultOn: true, autoScope: "session" });
      // v0.3.0 Goal 2 — learning (validated + Sources-required wiki stamp).
      const learning = lowerLearning(spec);
      // Loop contract 0.4 (Batch E, G23) — thredz is now emit-WIRED on this
      // shape (was carried-with-note): synthesize `mcp_servers.thredz` and
      // flip a declared memory block's backend, exactly like cli. The daemon
      // emitter ports target-cli's connectThredz boot fragment.
      const thredzLowered = lowerThredzWired(spec, {
        continuityGoalsOn: continuity.continuity?.plan === true,
        mcpServers: lowerMcpServers(spec.mcp_servers),
        memory: lowerMemory(spec),
      });
      const memoryLowered = applyLearningWikiGovernance(
        thredzLowered.memory !== undefined ? { memory: thredzLowered.memory } : {},
        learning.learning !== undefined,
      );
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-full");
      return {
        version: 0,
        name: spec.name,
        target: "channel",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          // 0.6.0 §4.3 — params + provenance; Loop contract 0.4 — rate limits.
          ...servingSlotFields(agentSlot),
          ...lowerRateLimits(spec.agent.rate_limits),
          ...lowerModelFailover(spec.agent, ctx, "agent"),
          ...servingSlotFailover(agentSlot),
        },
        tools: spec.agent.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.agent.tool_config),
        channels: lowerChannels(spec.channels),
        routing: { sessionKey: spec.routing.sessionKey },
        mcp_servers: thredzLowered.mcp_servers,
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents, ctx, "agent"),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
        ...lowerEvaluation(spec, ctx),
        ...lowerFeedback(spec),
        ...memoryLowered,
        // Loop contract 0.4 (Batch E, G22) — agent-shape RAG over doc sources.
        ...lowerKnowledge(spec),
        // v0.3.0 Goal 1 — DEFAULT-ON continuity. `auto` scope resolves to
        // `session` on channel: per-conversation stores ride the session
        // router's sessionId (§2.7/§14.5); heartbeat ticks read spec scope.
        ...continuity,
        // Loop contract 0.4 (Batch E, G23) — thredz emit-wired (see the
        // lowerThredzWired call above).
        ...(thredzLowered.thredz !== undefined ? { thredz: thredzLowered.thredz } : {}),
        ...learning,
        ...lowerObservability(spec),
        // "Watch me" — observe-and-learn (sibling of observability, §4.6).
        ...lowerWatchme(spec, ctx),
        // Batch G — MCP-server projection (G30) + plugin activation (G32).
        ...lowerExpose(spec),
        ...lowerPlugins(spec),
        // Phase 3 §3.1 — heartbeat. Duration string ("2h", "30m") is
        // parsed once at lower time so codegen emits a literal numeric
        // setInterval arg in ms.
        ...(spec.heartbeat !== undefined
          ? {
              heartbeat: {
                everyMs: parseDurationToMs(spec.heartbeat.every),
                instructions: spec.heartbeat.instructions,
              },
            }
          : {}),
        // Loop contract 0.4 (Batch F) — cron/interval wake trigger.
        ...lowerSchedule(spec.schedule),
        // Phase 3 §3.4 — gateway control-UI config.
        ...(spec.gateway !== undefined
          ? {
              gateway: {
                port: spec.gateway.port,
                ui: spec.gateway.ui,
              },
            }
          : {}),
        ...lowerChainSubsystem(spec),
      } satisfies IrChannelV0;
    }
    case "graph": {
      const topRef = resolveModelRef(spec.model, ctx, "model");
      return {
        version: 0,
        name: spec.name,
        target: "graph",
        ...registryField(ctx),
        entry: spec.entry,
        // Preserve YAML insertion order — nodes appear in the bundle in
        // the same order the spec author wrote them.
        nodes: Object.entries(spec.nodes).map(([name, node]) => {
          // Loop contract 0.4 (Batch B, G02) — judge gate nodes run no agent
          // turn of their own: instructions carry the criteria verbatim, the
          // judge model resolves into the ordinary `model` slot
          // (`judge.model ?? graph.model`, an auxiliary slot), and the
          // gate knobs resolve in `lowerJudgeGate`. `kind` exists ONLY on
          // the judge variant, so the `in` check is the discriminator.
          if ("kind" in node) {
            const judgeSlot =
              node.judge.model !== undefined
                ? resolveAuxSlot(node.judge.model, ctx, `nodes.${name}.judge.model`)
                : defaultJudgeSlot(ctx, `nodes.${name}.judge.model`);
            return {
              name,
              kind: "judge" as const,
              instructions: node.judge.criteria,
              model: judgeSlot?.model ?? topRef.model,
              tools: [],
              toolConfigs: lowerToolConfigs(undefined),
              judge: lowerJudgeGate(node.judge, judgeSlot, ctx, `nodes.${name}.judge`),
            };
          }
          const slotPath = node.model !== undefined ? `nodes.${name}.model` : "model";
          const slot = applyProfileToSlot(
            node.model !== undefined ? resolveModelRef(node.model, ctx, slotPath) : topRef,
            ctx,
            slotPath,
            "agent-full",
            {
              ...lowerThinking(node.thinking),
              ...(node.max_tokens !== undefined ? { maxTokens: node.max_tokens } : {}),
              ...(node.temperature !== undefined ? { temperature: node.temperature } : {}),
              hasRouting:
                node.model_pool !== undefined ||
                node.model_tiers !== undefined ||
                node.model_fallbacks !== undefined,
            },
          );
          return {
            name,
            instructions: foldOverlay(node.instructions, slot.overlay),
            model: slot.model,
            ...servingSlotFields(slot),
            tools: node.tools ?? [],
            toolConfigs: lowerToolConfigs(node.tool_config),
            // 0.6.0 §7.7 — per-node model routing (graph nodes carried none
            // before), the cli agent block's lowering verbatim.
            ...lowerModelFailover(node, ctx, `nodes.${name}`),
            ...servingSlotFailover(slot),
            ...(node.hitl !== undefined ? { hitlPrompt: node.hitl.prompt } : {}),
          };
        }),
        // Loop contract 0.4 (Batch A) — `when` lowers 1:1 (exactly one of
        // equals/exists survives the spec's superRefine); declaration order
        // is semantics (first matching edge wins), so no reordering.
        edges: spec.edges.map((e) => ({
          from: e.from,
          to: e.to,
          ...(e.when !== undefined
            ? {
                when: {
                  key: e.when.key,
                  ...(e.when.equals !== undefined ? { equals: e.when.equals } : {}),
                  ...(e.when.exists !== undefined ? { exists: e.when.exists } : {}),
                },
              }
            : {}),
        })),
        // Loop contract 0.4 (Batch A) — parallel barrier groups, verbatim
        // (group order and member order are execution semantics).
        ...(spec.parallel !== undefined
          ? { parallel: spec.parallel.map((group) => [...group]) }
          : {}),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        ...lowerChainSubsystem(spec),
      } satisfies IrGraphV0;
    }
    case "managed": {
      const continuity = lowerContinuity(spec, { defaultOn: true, autoScope: "spec" });
      // v0.3.0 Goal 2 — learning (validated + Sources-required wiki stamp).
      const learning = lowerLearning(spec);
      // Loop contract 0.4 (Batch E, G23) — thredz emit-WIRED (was carried).
      // Managed has no mcp_servers field, so the daemon synthesizes the
      // thredz server from IrThredz; here we carry it + flip the memory
      // backend.
      const thredzLowered = lowerThredzWiredNoMcp(spec, {
        continuityGoalsOn: continuity.continuity?.plan === true,
        memory: lowerMemory(spec),
      });
      const memoryLowered = applyLearningWikiGovernance(
        thredzLowered.memory !== undefined ? { memory: thredzLowered.memory } : {},
        learning.learning !== undefined,
      );
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-full");
      return {
        version: 0,
        name: spec.name,
        target: "managed",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          // 0.6.0 §4.3 — params + provenance; Loop contract 0.4 — rate limits.
          ...servingSlotFields(agentSlot),
          ...lowerRateLimits(spec.agent.rate_limits),
          ...lowerModelFailover(spec.agent, ctx, "agent"),
          ...servingSlotFailover(agentSlot),
        },
        tenants: spec.tenants.map((t) => ({
          id: t.id,
          budget: {
            maxInputTokens: t.budget.maxInputTokens,
            maxOutputTokens: t.budget.maxOutputTokens,
          },
        })),
        // Loop contract 0.4 (Batch F, G81) — the managed daemon's tool catalog
        // + tool_config overlays (per-tenant application is a runtime
        // policy-engine concern). Spread-return-{} so a managed bundle without
        // tools stays byte-identical; the emitter reads `ir.tools ?? []`.
        ...(spec.agent.tools !== undefined ? { tools: [...spec.agent.tools] } : {}),
        ...(spec.agent.tool_config !== undefined
          ? { toolConfigs: lowerToolConfigs(spec.agent.tool_config) }
          : {}),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // Loop contract 0.4 (Batch F) — cron/interval wake trigger.
        ...lowerSchedule(spec.schedule),
        // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
        ...lowerEvaluation(spec, ctx),
        // NEW-inloop-coverage — rating capture on the gateway shape.
        ...lowerFeedback(spec),
        ...memoryLowered,
        // Loop contract 0.4 (Batch E, G22) — agent-shape RAG over doc sources.
        ...lowerKnowledge(spec),
        // v0.3.0 Goal 1 — DEFAULT-ON continuity. `auto` resolves to `spec`
        // scope; the managed daemon tenant-fences every store at boot (the
        // wireMemory deps carry the tenant, §2.7).
        ...continuity,
        // Loop contract 0.4 (Batch E, G23) — thredz emit-wired (see the
        // lowerThredzWiredNoMcp call above).
        ...(thredzLowered.thredz !== undefined ? { thredz: thredzLowered.thredz } : {}),
        ...learning,
        ...lowerObservability(spec),
        // "Watch me" — observe-and-learn, lowered but NOT runtime-wired on
        // managed in v1 (compile() emits the accepted-but-unwired warning).
        ...lowerWatchme(spec, ctx),
        // Batch G — MCP-server projection (G30); SSE exposure rides this
        // shape's gateway tenancy. No plugins on managed (item 3 boot paths
        // cover cli + channel-bot codegen).
        ...lowerExpose(spec),
      } satisfies IrManagedV0;
    }
    case "pipeline": {
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-temperature");
      return {
        version: 0,
        name: spec.name,
        target: "pipeline",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          ...servingSlotFields(agentSlot),
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent, ctx, "agent"),
        },
        retrieve: {
          embedderModel: spec.retrieve.embedderModel,
          vectorBackend: spec.retrieve.vectorBackend,
          defaultK: spec.retrieve.defaultK,
          ...(spec.retrieve.url !== undefined ? { url: spec.retrieve.url } : {}),
          ...(spec.retrieve.collection !== undefined
            ? { collection: spec.retrieve.collection }
            : {}),
          // apiKey flows through the same `$VAR` → env-ref lowering as other
          // secrets so a real key never lands in the compiled bundle.
          ...(spec.retrieve.apiKey !== undefined
            ? { apiKey: lowerCredential("retrieve.apiKey", spec.retrieve.apiKey) }
            : {}),
        },
        indexing: {
          chunkStrategy: spec.indexing.chunkStrategy,
          chunkSize: spec.indexing.chunkSize,
          chunkOverlap: spec.indexing.chunkOverlap,
          documents: spec.indexing.documents.map((d) => ({
            id: d.id,
            text: d.text,
            ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
          })),
        },
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
      } satisfies IrPipelineV0;
    }
    case "crew": {
      const continuity = lowerContinuity(spec, { defaultOn: true, autoScope: "spec" });
      // v0.3.0 Goal 2 — learning (validated + Sources-required wiki stamp).
      const learning = lowerLearning(spec);
      // 0.5.0 — thredz is emit-wired on crew, with the per-role fan-out. This
      // resolves each role's config, assigns it a server name, and synthesizes
      // one mcp_servers entry per DISTINCT server.
      const crewThredz = lowerThredzWiredCrew(spec, {
        continuityGoalsOn: continuity.continuity?.plan === true,
        mcpServers: lowerMcpServers(spec.mcp_servers),
        memory: lowerMemory(spec),
      });
      // 0.6.0 §4.3 — the crew-wide `model` slot resolves once; a role without
      // its own `model` inherits the resolved slot AND its profile.
      const topRef = resolveModelRef(spec.model, ctx, "model");
      const routerModel =
        spec.routing?.model !== undefined
          ? resolveModelOnly(spec.routing.model, ctx, "routing.model")
          : undefined;
      return {
        version: 0,
        name: spec.name,
        target: "crew",
        ...registryField(ctx),
        entry: spec.entry,
        // Stable order: sort by role name so generated bundles diff cleanly.
        roles: Object.entries(spec.roles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, role]) => {
            const lowered = lowerCrewRole(name, role, topRef, ctx);
            // 0.5.0 — attach this role's RESOLVED Thredz config and the
            // server it rides. Absent for a role with no hosted wiki.
            const wired = crewThredz.roleThredz.get(name);
            return wired === undefined
              ? lowered
              : { ...lowered, thredz: wired.thredz, thredzServer: wired.server };
          }),
        ...(spec.routing !== undefined
          ? {
              routing: {
                kind: spec.routing.kind,
                ...(spec.routing.match !== undefined ? { match: spec.routing.match } : {}),
                // 0.6.0 §7.7 — the llm router's own model slot (was hard-wired
                // to the entry role's model).
                ...(routerModel !== undefined ? { model: routerModel.model } : {}),
                ...(routerModel?.profile !== undefined
                  ? { modelProfile: routerModel.profile }
                  : {}),
              },
            }
          : {}),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        // Loop contract 0.4 (Batch A) — the crew limits block may carry the
        // crew-only `limits.crew` orchestration ceilings.
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // v0.3.0 — crew joins the memory-carrying shapes (§9) and gets
        // DEFAULT-ON continuity: roles share the `spec`-scoped plan store
        // (the plan IS the coordination surface, §2.7). The memory here is
        // the THREDZ-FLIPPED one when a hosted wiki is wired.
        ...applyLearningWikiGovernance(
          crewThredz.memory !== undefined ? { memory: crewThredz.memory } : lowerMemory(spec),
          learning.learning !== undefined,
        ),
        ...continuity,
        // 0.5.0 — thredz is EMIT-WIRED on crew, with the per-role fan-out:
        // one key (and therefore one space, and one npx process) per role
        // that overrides the crew-wide block.
        ...(({ roleThredz: _drop, ...rest }) => rest)(crewThredz),
        ...learning,
        // Loop contract 0.4 (Batch C, G26) — observability subscriber/exporter
        // controls (crew joins cli/channel/managed).
        ...lowerObservability(spec),
        ...lowerChainSubsystem(spec),
      } satisfies IrCrewV0;
    }
    case "research": {
      const continuity = lowerContinuity(spec, { defaultOn: true, autoScope: "spec" });
      // v0.3.0 Goal 2 — learning (validated + Sources-required wiki stamp).
      const learning = lowerLearning(spec);
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-params");
      return {
        version: 0,
        name: spec.name,
        target: "research",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          ...servingSlotFields(agentSlot),
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent, ctx, "agent"),
        },
        goal: spec.goal,
        branchingFactor: spec.branchingFactor,
        maxDurationMs: spec.maxDurationMs,
        retrieve: {
          allowedOrigins: [...spec.retrieve.allowedOrigins],
          allowedFileRoots: [...spec.retrieve.allowedFileRoots],
          ...(spec.retrieve.vectorBackend !== undefined
            ? { vectorBackend: spec.retrieve.vectorBackend }
            : {}),
        },
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        ...applyLearningWikiGovernance(lowerMemory(spec), learning.learning !== undefined),
        // v0.3.0 Goal 1 — DEFAULT-ON continuity, `spec` scope (§2.7).
        ...continuity,
        // v0.3.0 Goal 3 — thredz is CARRIED on this shape (ignored-note in
        // the emitted daemon), not emit-wired yet.
        ...lowerThredzCarried(spec, continuity.continuity?.plan === true, "research"),
        ...learning,
        ...lowerChainSubsystem(spec),
      } satisfies IrResearchV0;
    }
    case "batch": {
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-params");
      return {
        version: 0,
        name: spec.name,
        target: "batch",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          ...servingSlotFields(agentSlot),
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent, ctx, "agent"),
        },
        queue: {
          adapter: spec.queue.adapter,
          visibilityTimeoutMs: spec.queue.visibilityTimeoutMs,
          ...(spec.queue.visibilityRenewIntervalMs !== undefined
            ? { visibilityRenewIntervalMs: spec.queue.visibilityRenewIntervalMs }
            : {}),
          maxRetries: spec.queue.maxRetries,
          ...(spec.queue.seedJobs !== undefined ? { seedJobs: [...spec.queue.seedJobs] } : {}),
        },
        concurrency: spec.concurrency,
        idempotencyWindowMs: spec.idempotencyWindowMs,
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
        // Loop contract 0.4 (Batch F) — cron/interval wake trigger.
        ...lowerSchedule(spec.schedule),
        ...lowerChainSubsystem(spec),
      } satisfies IrBatchV0;
    }
    case "voice": {
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-model");
      return {
        version: 0,
        name: spec.name,
        target: "voice",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          ...(agentSlot.modelProfile !== undefined ? { modelProfile: agentSlot.modelProfile } : {}),
        },
        voice: {
          provider: spec.voice.provider,
          voiceId: spec.voice.voiceId,
          vad: spec.voice.vad,
          bargeInTriggerFrames: spec.voice.bargeInTriggerFrames,
          bargeInWindowMs: spec.voice.bargeInWindowMs,
        },
        ...(spec.telephony !== undefined
          ? { telephony: { provider: spec.telephony.provider } }
          : {}),
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
      } satisfies IrVoiceV0;
    }
    case "browser": {
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-params");
      // 0.6.0 §4.3 — the vision-grounding model is an auxiliary slot (it
      // bypassed `resolveAuxModel`); absent → the resolved agent model.
      const grounding =
        spec.groundingModel !== undefined
          ? resolveAuxSlot(spec.groundingModel, ctx, "groundingModel")
          : undefined;
      return {
        version: 0,
        name: spec.name,
        target: "browser",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          ...servingSlotFields(agentSlot),
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent, ctx, "agent"),
        },
        driver: {
          backend: spec.driver.backend,
          viewport: { width: spec.driver.viewport.width, height: spec.driver.viewport.height },
          ...(spec.driver.startUrl !== undefined ? { startUrl: spec.driver.startUrl } : {}),
          // SECURITY — carried ONLY when the spec opts in, so every bundle
          // that leaves it at the default stays byte-identical to 0.4.1.
          ...(spec.driver.allowPrivateTargets ? { allowPrivateTargets: true } : {}),
        },
        groundingModel: grounding?.model ?? agentSlot.model,
        ...(grounding?.modelProfile !== undefined
          ? { groundingModelProfile: grounding.modelProfile }
          : {}),
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec, ctx),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
      } satisfies IrBrowserV0;
    }
    case "eval": {
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-model");
      return {
        version: 0,
        name: spec.name,
        target: "eval",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          tools: spec.agent.tools ?? [],
          ...(agentSlot.modelProfile !== undefined ? { modelProfile: agentSlot.modelProfile } : {}),
        },
        dataset: {
          name: spec.dataset.name,
          version: spec.dataset.version,
          split: spec.dataset.split,
        },
        graders: spec.graders.map((g) => ({
          name: g.name,
          ...(g.opts !== undefined ? { opts: g.opts } : {}),
        })),
        concurrency: spec.concurrency,
        ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
        ...lowerFailureTaxonomy(spec),
      } satisfies IrEvalV0;
    }
    case "onchain": {
      const lowered = lowerChainSubsystem(spec);
      if (lowered.chains === undefined || lowered.chains.length === 0) {
        throw new Error("onchain target requires chains[] to be non-empty");
      }
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-model");
      return {
        version: 0,
        name: spec.name,
        target: "onchain",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          ...(agentSlot.modelProfile !== undefined ? { modelProfile: agentSlot.modelProfile } : {}),
        },
        chains: lowered.chains,
        wallets: lowered.wallets ?? [],
        contracts: lowered.contracts ?? [],
        transactionPolicy: lowered.transactionPolicy ?? {
          defaultWriteApproval: "required",
          allowedContracts: [],
          simulationRequired: true,
        },
        triggers: spec.triggers.map((t) => {
          if (t.kind === "event") {
            return {
              kind: "event",
              chainId: t.chainId,
              contract: t.contract,
              event: t.event,
              ...(t.filter !== undefined ? { filter: t.filter } : {}),
            };
          }
          if (t.kind === "block") {
            return {
              kind: "block",
              chainId: t.chainId,
              scanIntervalMs: t.scanIntervalMs,
            };
          }
          return {
            kind: "address",
            chainId: t.chainId,
            address: t.address,
            direction: t.direction,
          };
        }),
        idempotencyWindowMs: spec.idempotencyWindowMs,
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
      } satisfies IrChainV0;
    }
    case "onchain-game": {
      // onchain-game inlines a single chain/wallet/contract, so we lower them
      // through the shared subsystem helper and pull the single element out of
      // each result. The helper sets each output array iff the matching input
      // array is provided, and we always provide non-empty single-element
      // inputs here, so chains/wallets/contracts are each a populated [0].
      const lowered = lowerChainSubsystem({
        chains: [spec.chain],
        wallets: [spec.wallet],
        contracts: [spec.game.contract],
        transaction_policy: spec.transaction_policy,
      });
      const { chain, wallet, contract } = assertChainGameLowered(
        lowered.chains?.[0],
        lowered.wallets?.[0],
        lowered.contracts?.[0],
      );
      const agentSlot = resolveServingAgent(spec.agent, ctx, "agent-model");
      return {
        version: 0,
        name: spec.name,
        target: "onchain-game",
        ...registryField(ctx),
        agent: {
          model: agentSlot.model,
          instructions: foldOverlay(spec.agent.instructions, agentSlot.overlay),
          ...(agentSlot.modelProfile !== undefined ? { modelProfile: agentSlot.modelProfile } : {}),
        },
        chain,
        wallet,
        game: {
          contract,
          stateReader: spec.game.stateReader,
          turnSemantics: spec.game.turnSemantics,
          ...(spec.game.actionsContract !== undefined
            ? { actionsContract: spec.game.actionsContract }
            : {}),
          ...(spec.game.moveTimeoutMs !== undefined
            ? { moveTimeoutMs: spec.game.moveTimeoutMs }
            : {}),
          ...(spec.game.objective !== undefined ? { objective: spec.game.objective } : {}),
        },
        transactionPolicy: lowered.transactionPolicy ?? {
          defaultWriteApproval: "required",
          allowedContracts: [],
          simulationRequired: true,
        },
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec, ctx),
        ...lowerFailureTaxonomy(spec),
      } satisfies IrChainGameV0;
    }
    default:
      return assertNever(spec);
  }
}

function lowerCrewRole(
  name: string,
  role: SpecCrewRole,
  topRef: ResolvedModelRef,
  ctx: LowerContext,
): IrCrewRole {
  const path = `roles.${name}`;
  const slotPath = role.model !== undefined ? `${path}.model` : "model";
  // 0.6.0 §4.3 — the role's slot: its own `model` (a `$profile`, a sentinel
  // or a grammar string) or the crew-wide resolved slot with its profile.
  const slot = applyProfileToSlot(
    role.model !== undefined ? resolveModelRef(role.model, ctx, slotPath) : topRef,
    ctx,
    slotPath,
    "agent-full",
    {
      ...lowerThinking(role.thinking),
      ...(role.max_tokens !== undefined ? { maxTokens: role.max_tokens } : {}),
      ...(role.temperature !== undefined ? { temperature: role.temperature } : {}),
      hasRouting:
        role.model_pool !== undefined ||
        role.model_tiers !== undefined ||
        role.model_fallbacks !== undefined,
    },
  );
  return {
    name,
    model: slot.model,
    instructions: foldOverlay(role.instructions, slot.overlay),
    ...servingSlotFields(slot),
    tools: role.tools ?? [],
    toolConfigs: lowerToolConfigs(role.tool_config),
    subAgents: lowerSubAgents(role.sub_agents, ctx, path),
    // Item 9 (G37) — per-role model routing (failover/tiers/pool), reusing the
    // cli agent block's lowering verbatim.
    ...lowerModelFailover(role, ctx, path),
    ...servingSlotFailover(slot),
  };
}

function emit(ir: IrNode, opts: EmitReadmeOptions = {}): Bundle {
  switch (ir.target) {
    case "cli":
      return emitCli(ir, opts);
    case "workflow":
      return emitWorkflow(ir, opts);
    case "channel":
      return emitChannelBot(ir, opts);
    case "graph":
      return emitGraph(ir, opts);
    case "managed":
      return emitManaged(ir, opts);
    case "pipeline":
      return emitPipeline(ir, opts);
    case "crew":
      return emitCrew(ir, opts);
    case "research":
      return emitResearchBundle(ir, opts);
    case "batch":
      return emitBatchWorker(ir, opts);
    case "voice":
      return emitVoice(ir, opts);
    case "browser":
      return emitBrowserDriver(ir, opts);
    case "eval":
      return emitEval(ir, opts);
    case "onchain":
      return emitOnchain(ir, opts);
    case "onchain-game":
      return emitOnchainGame(ir, opts);
    default:
      return assertNever(ir);
  }
}

export type { Bundle, IrV0, IrWorkflowV0, IrChannelV0, IrNode } from "@crewhaus/ir";
export { type Spec, parseSpec, SpecParseError } from "@crewhaus/spec";
