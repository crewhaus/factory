import { CHEAPEST_SENTINEL, resolveCheapestForSlot } from "@crewhaus/cost-tracker";
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
  IrModelPool,
  IrModelTiers,
  IrNode,
  IrObservability,
  IrPermissions,
  IrPipelineV0,
  IrResearchV0,
  IrSchedule,
  IrSecretRef,
  IrSecurity,
  IrSlackConfig,
  IrSubAgentDefinition,
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
import {
  type Spec,
  type SpecChannel,
  type SpecCrewRole,
  type SpecDiscordChannel,
  type SpecIMessageChannel,
  type SpecMcpServerConfig,
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
};

/**
 * Loop contract 0.4 (Batch A, G45 warnings framework) — one non-fatal
 * compile diagnostic. `code` is a stable machine key
 * (`"accepted-but-unwired"`, `"edge-unsafe-tool"`,
 * `"channel-reactions-join"`, `"cli-autodistill-toolchain"`,
 * `"managed-feedback-unsupported"`), `path` the spec
 * key it concerns (dot-joined),
 * `message` the human explanation. Additive: every existing `compile()`
 * consumer that only reads `.files` keeps working unchanged.
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
  let ir = lower(spec);
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
  return { files: bundle.files, warnings: collectCompileWarnings(spec) };
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
 * `model_fallbacks` are nested under `roles`/`steps` and wired at lower time,
 * so they carry no row either.
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
  crew: [unwired("thredz", "crew", "the generated bundle prints the ignored-note comment")],
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
  return out;
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
    if (cfg.transport === "stdio") {
      out[name] = {
        transport: "stdio",
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.env !== undefined
          ? { env: lowerMcpSecretMap(cfg.env, `mcp_servers.${name}`, "env") }
          : {}),
      };
    } else {
      out[name] = {
        transport: "sse",
        url: cfg.url,
        ...(cfg.headers !== undefined
          ? { headers: lowerMcpSecretMap(cfg.headers, `mcp_servers.${name}`, "headers") }
          : {}),
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
 */
function lowerSubAgents(
  map: Record<string, SpecSubAgentDefinition> | undefined,
): IrSubAgentDefinition[] {
  if (map === undefined) return [];
  // Stable order: sort by name so generated bundles diff cleanly.
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([name, def]) => ({
    name,
    description: def.description,
    instructions: def.instructions,
    tools: def.tools ?? [],
    ...(def.model !== undefined ? { model: def.model } : {}),
    permissions: def.permissions ?? "inherit",
    inheritBypass: def.inherit_bypass ?? false,
    // Item 2 (G31) — federated-peer reference. Carried only when declared; the
    // spawner routes through the federation-router when present.
    ...(def.federation !== undefined ? { federation: { url: def.federation.url } } : {}),
  }));
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
 */
function lowerCompaction(spec: SpecWithPermissions): IrCompaction {
  const c = spec.compaction;
  if (c === undefined) return {};
  // Propagate each defined field verbatim. Defaults belong at the
  // consumer site (curator's `DEFAULT_DEDUPE_THRESHOLD`, autocompact's
  // primary-model fallback) so the IR carries the user's intent
  // without lying about defaults.
  const out: {
    -readonly [K in keyof IrCompaction]: IrCompaction[K];
  } = {};
  if (c.model !== undefined) out.model = resolveAuxModel(c.model, spec, "compaction.model");
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

/**
 * Item 25 — the `cheapest` sentinel for an AUX model knob (compaction.model,
 * judge model, …). Resolved AT COMPILE TIME to the lowest-cost same-provider
 * model (as the primary's provider) whose capabilities satisfy the slot, so
 * the IR — and every emitted bundle — carries a concrete model id. An aux slot
 * summarizes / grades text, so its capability requirement is empty (any
 * same-provider family qualifies); `cheapest` therefore resolves to the
 * provider's cheapest family. A non-`cheapest` value passes through verbatim.
 *
 * The primary model lives in different places depending on target shape:
 * `cli`/`managed`/`pipeline`/`research`/… carry it under `agent.model`, while
 * `workflow`/`graph`/`crew` carry it as a required TOP-LEVEL `model` field
 * (no `agent` block at all). `lowerCompaction` runs for every target, so this
 * checks `agent.model` first and falls back to the top-level `model`.
 *
 * When the primary is a provider the pricing table doesn't cover (local/,
 * azure/, a named host) `cheapest` cannot be resolved offline — the sentinel
 * is a compile ERROR there (the operator must name a concrete model), because
 * silently leaving the literal string `"cheapest"` in the IR would fail later
 * at `resolveModel` with a far less actionable message.
 */
function resolveAuxModel(value: string, spec: SpecWithPermissions, slotLabel: string): string {
  if (value !== CHEAPEST_SENTINEL) return value;
  const specLike = spec as { agent?: { model?: unknown }; model?: unknown };
  const primary = specLike.agent?.model ?? specLike.model;
  if (typeof primary !== "string") {
    throw new CompilerError(
      `${slotLabel}: "cheapest" needs a primary agent.model to resolve against, but this spec has none`,
    );
  }
  const resolved = resolveCheapestForSlot(primary);
  if (resolved === undefined) {
    throw new CompilerError(
      `${slotLabel}: "cheapest" cannot be resolved for primary model "${primary}" — its provider is not in the pricing table (local/azure/named-host). Name a concrete model instead.`,
    );
  }
  return resolved;
}

/**
 * Item 22 — lower the optional failover-chain fields off an agent block
 * (`model_fallbacks` + `circuit_breaker`). Mirrors `lowerCompaction`'s
 * "propagate only defined fields" discipline: the breaker package owns the
 * per-knob defaults, so the IR carries the user's intent verbatim. Returns
 * a partial spread into the IR agent object so both fields stay ABSENT when
 * the spec omits them (emitters gate their codegen on presence).
 */
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
  readonly model_pool?: {
    readonly candidates: ReadonlyArray<{
      readonly model: string;
      readonly tags: readonly string[];
    }>;
    readonly policy: "static" | "heuristic" | "learned";
    readonly objective?: {
      readonly quality?: number;
      readonly cost?: number;
      readonly latency?: number;
    };
    readonly routing?: {
      readonly contextTokenThreshold?: number;
      readonly toolsToDefault?: boolean;
      readonly firstTurnToDefault?: boolean;
      readonly priorToolDensityThreshold?: number;
      readonly strongTag?: string;
      readonly cheapTag?: string;
    };
    readonly learning?: {
      readonly minSamplesPerArm?: number;
      readonly costRefUsd?: number;
      readonly latencyRefMs?: number;
      readonly explorationRate?: number;
      readonly seed?: string;
      readonly bandit?: "epsilon-greedy" | "thompson";
    };
  };
};

function lowerModelFailover(agent: SpecAgentWithFailover): {
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
    out.modelFallbacks = [...agent.model_fallbacks];
  }
  const cb = agent.circuit_breaker;
  if (cb !== undefined) {
    out.circuitBreaker = {
      ...(cb.failureThreshold !== undefined ? { failureThreshold: cb.failureThreshold } : {}),
      ...(cb.windowMs !== undefined ? { windowMs: cb.windowMs } : {}),
      ...(cb.cooldownMs !== undefined ? { cooldownMs: cb.cooldownMs } : {}),
    };
  }
  // Item 26 — two-tier router. Only lowered when present; the routing knobs
  // carry the user's intent verbatim (runtime owns the per-knob defaults).
  const mt = agent.model_tiers;
  if (mt !== undefined) {
    const routing = mt.routing;
    out.modelTiers = {
      fast: mt.fast,
      default: mt.default,
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
    const objective = mp.objective;
    const routing = mp.routing;
    const learning = mp.learning;
    out.modelPool = {
      candidates: mp.candidates.map((c) => ({ model: c.model, tags: [...c.tags] })),
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
  };
};

function lowerBudget(spec: SpecWithBudget): { budget?: IrBudget } {
  const b = spec.budget;
  if (b === undefined) return {};
  const usdMicros = Math.round(b.usd * 1_000_000);
  const onExceed: IrBudget["onExceed"] =
    b.on_exceed.action === "degrade"
      ? { kind: "degrade", model: b.on_exceed.model }
      : { kind: "stop" };
  return { budget: { usdMicros, onExceed } };
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
      | { readonly type: "llm_judge"; readonly criteria: string; readonly model?: string }
      | { readonly type: "contains"; readonly value: string }
      | { readonly type: "regex"; readonly value: string };
    readonly threshold?: number;
    readonly on_fail?: "retry" | "halt" | "note";
    readonly max_retries?: number;
  };
};

function lowerEvaluation(spec: SpecWithEvaluation): { evaluation?: IrEvaluation } {
  const e = spec.evaluation;
  if (e === undefined) return {};
  const grader: IrEvaluation["grader"] =
    e.grader.type === "llm_judge"
      ? {
          type: "llm_judge",
          criteria: e.grader.criteria,
          ...(e.grader.model !== undefined
            ? { model: resolveAuxModel(e.grader.model, spec, "evaluation.grader.model") }
            : {}),
        }
      : e.grader.type === "contains"
        ? { type: "contains", value: e.grader.value }
        : { type: "regex", value: e.grader.value };
  return {
    evaluation: {
      grader,
      ...(e.grader.type === "llm_judge" ? { threshold: e.threshold ?? 0.7 } : {}),
      onFail: e.on_fail ?? "retry",
      maxRetries: e.max_retries ?? 1,
    },
  };
}

/**
 * Loop contract 0.4 (Batch B, G02) — resolve a judge gate's knobs
 * (defaults: threshold 0.7, on_fail `"retry_previous"`, max_retries 1).
 * The judge MODEL is deliberately NOT part of `IrJudge`: the caller
 * resolves it into the judge step's/node's ordinary `model` field
 * (`judge.model ?? <shape>.model`, `cheapest` supported via
 * `resolveAuxModel`) so emitters read one model slot per step/node.
 */
type SpecJudgeGateBlock = {
  readonly criteria: string;
  readonly model?: string;
  readonly threshold?: number;
  readonly on_fail?: "retry_previous" | "halt" | "continue";
  readonly max_retries?: number;
};

function lowerJudgeGate(judge: SpecJudgeGateBlock): IrJudge {
  return {
    criteria: judge.criteria,
    threshold: judge.threshold ?? 0.7,
    onFail: judge.on_fail ?? "retry_previous",
    maxRetries: judge.max_retries ?? 1,
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

function lowerSecurity(spec: SpecWithSecurity): { security?: IrSecurity } {
  const s = spec.security;
  if (s === undefined) return {};
  // FR-004 `justification` and FR-006 `egressMatcher` are independent
  // optional sub-fields of the same `security` block: carry whichever is
  // present. The block is dropped from the IR only when both are absent.
  const justification =
    s.justification !== undefined
      ? {
          judge: s.justification.judge,
          ...(s.justification.model !== undefined ? { model: s.justification.model } : {}),
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
      readonly api_key: string;
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
function lowerThredzCarried(
  spec: SpecWithThredz,
  continuityGoalsOn: boolean,
  shape: string,
): { thredz?: IrThredz } {
  if (spec.memory?.backend === "thredz") {
    throw new CompilerError(
      `memory.backend "thredz" is emit-wired on cli/channel/managed in this release — the ${shape} shape carries the thredz: block for forward compatibility but keeps the local backend. Remove the backend override.`,
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
function lowerWatchme(spec: SpecWithWatchme): { watchme?: IrWatchme } {
  const w = spec.watchme;
  if (w === undefined) return {};
  return {
    watchme: {
      enabled: w.enabled,
      capture: w.capture,
      judgeModel: w.judge?.model ?? "claude-haiku-4-5",
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

export function lower(spec: Spec): IrNode {
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
      return {
        version: 0,
        name: spec.name,
        target: "cli",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          ...(spec.agent.max_tokens !== undefined ? { maxTokens: spec.agent.max_tokens } : {}),
          // Loop contract 0.4 (Batch A) — thinking / streaming / rate limits.
          ...lowerThinking(spec.agent.thinking),
          ...(spec.agent.streaming !== undefined ? { streaming: spec.agent.streaming } : {}),
          ...lowerRateLimits(spec.agent.rate_limits),
          ...lowerModelFailover(spec.agent),
        },
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: thredzLowered.mcp_servers,
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
        ...lowerEvaluation(spec),
        ...lowerSecurity(spec),
        ...lowerFeedback(spec),
        ...memoryLowered,
        // Loop contract 0.4 (Batch E, G22) — agent-shape RAG over doc sources.
        ...lowerKnowledge(spec),
        ...continuity,
        ...(thredzLowered.thredz !== undefined ? { thredz: thredzLowered.thredz } : {}),
        ...learning,
        ...lowerObservability(spec),
        // "Watch me" — observe-and-learn (sibling of observability, §4.6).
        ...lowerWatchme(spec),
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
    case "workflow":
      return {
        version: 0,
        name: spec.name,
        target: "workflow",
        steps: spec.steps.map((s, i) => {
          // Loop contract 0.4 (Batch B, G02) — judge gate steps run no agent
          // turn of their own: instructions carry the criteria verbatim, the
          // judge model resolves into the ordinary `model` slot
          // (`judge.model ?? workflow.model`, `cheapest` supported), and the
          // gate knobs resolve in `lowerJudgeGate`. `kind` exists ONLY on
          // the judge variant, so the `in` check is the discriminator.
          if ("kind" in s) {
            return {
              name: s.name,
              kind: "judge" as const,
              instructions: s.judge.criteria,
              model:
                s.judge.model !== undefined
                  ? resolveAuxModel(s.judge.model, spec, `steps[${i}].judge.model`)
                  : spec.model,
              tools: [],
              toolConfigs: lowerToolConfigs(undefined),
              judge: lowerJudgeGate(s.judge),
            };
          }
          return {
            name: s.name,
            instructions: s.instructions,
            model: s.model ?? spec.model,
            ...(s.max_tokens !== undefined ? { maxTokens: s.max_tokens } : {}),
            // Loop contract 0.4 (Batch A) — per-step thinking selector.
            ...lowerThinking(s.thinking),
            tools: s.tools ?? [],
            toolConfigs: lowerToolConfigs(s.tool_config),
            // Item 9 (G37) — per-step model routing (failover/tiers/pool),
            // reusing the cli agent block's lowering verbatim.
            ...lowerModelFailover(s),
          };
        }),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
        ...lowerChainSubsystem(spec),
      } satisfies IrWorkflowV0;
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
      return {
        version: 0,
        name: spec.name,
        target: "channel",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          ...(spec.agent.max_tokens !== undefined ? { maxTokens: spec.agent.max_tokens } : {}),
          // Loop contract 0.4 (Batch A) — thinking / rate limits.
          ...lowerThinking(spec.agent.thinking),
          ...lowerRateLimits(spec.agent.rate_limits),
          ...lowerModelFailover(spec.agent),
        },
        tools: spec.agent.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.agent.tool_config),
        channels: lowerChannels(spec.channels),
        routing: { sessionKey: spec.routing.sessionKey },
        mcp_servers: thredzLowered.mcp_servers,
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
        ...lowerEvaluation(spec),
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
        ...lowerWatchme(spec),
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
    case "graph":
      return {
        version: 0,
        name: spec.name,
        target: "graph",
        entry: spec.entry,
        // Preserve YAML insertion order — nodes appear in the bundle in
        // the same order the spec author wrote them.
        nodes: Object.entries(spec.nodes).map(([name, node]) => {
          // Loop contract 0.4 (Batch B, G02) — judge gate nodes run no agent
          // turn of their own: instructions carry the criteria verbatim, the
          // judge model resolves into the ordinary `model` slot
          // (`judge.model ?? graph.model`, `cheapest` supported), and the
          // gate knobs resolve in `lowerJudgeGate`. `kind` exists ONLY on
          // the judge variant, so the `in` check is the discriminator.
          if ("kind" in node) {
            return {
              name,
              kind: "judge" as const,
              instructions: node.judge.criteria,
              model:
                node.judge.model !== undefined
                  ? resolveAuxModel(node.judge.model, spec, `nodes.${name}.judge.model`)
                  : spec.model,
              tools: [],
              toolConfigs: lowerToolConfigs(undefined),
              judge: lowerJudgeGate(node.judge),
            };
          }
          return {
            name,
            instructions: node.instructions,
            model: node.model ?? spec.model,
            ...(node.max_tokens !== undefined ? { maxTokens: node.max_tokens } : {}),
            // Loop contract 0.4 (Batch A) — per-node thinking selector.
            ...lowerThinking(node.thinking),
            tools: node.tools ?? [],
            toolConfigs: lowerToolConfigs(node.tool_config),
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
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        ...lowerChainSubsystem(spec),
      } satisfies IrGraphV0;
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
      return {
        version: 0,
        name: spec.name,
        target: "managed",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          ...(spec.agent.max_tokens !== undefined ? { maxTokens: spec.agent.max_tokens } : {}),
          // Loop contract 0.4 (Batch A) — thinking / rate limits.
          ...lowerThinking(spec.agent.thinking),
          ...lowerRateLimits(spec.agent.rate_limits),
          ...lowerModelFailover(spec.agent),
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
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // Loop contract 0.4 (Batch F) — cron/interval wake trigger.
        ...lowerSchedule(spec.schedule),
        // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
        ...lowerEvaluation(spec),
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
        ...lowerWatchme(spec),
        // Batch G — MCP-server projection (G30); SSE exposure rides this
        // shape's gateway tenancy. No plugins on managed (item 3 boot paths
        // cover cli + channel-bot codegen).
        ...lowerExpose(spec),
      } satisfies IrManagedV0;
    }
    case "pipeline":
      return {
        version: 0,
        name: spec.name,
        target: "pipeline",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent),
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
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
      } satisfies IrPipelineV0;
    case "crew": {
      const continuity = lowerContinuity(spec, { defaultOn: true, autoScope: "spec" });
      // v0.3.0 Goal 2 — learning (validated + Sources-required wiki stamp).
      const learning = lowerLearning(spec);
      return {
        version: 0,
        name: spec.name,
        target: "crew",
        entry: spec.entry,
        // Stable order: sort by role name so generated bundles diff cleanly.
        roles: Object.entries(spec.roles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, role]) => lowerCrewRole(name, role, spec.model)),
        ...(spec.routing !== undefined
          ? {
              routing: {
                kind: spec.routing.kind,
                ...(spec.routing.match !== undefined ? { match: spec.routing.match } : {}),
              },
            }
          : {}),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        // Loop contract 0.4 (Batch A) — the crew limits block may carry the
        // crew-only `limits.crew` orchestration ceilings.
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // v0.3.0 — crew joins the memory-carrying shapes (§9) and gets
        // DEFAULT-ON continuity: roles share the `spec`-scoped plan store
        // (the plan IS the coordination surface, §2.7).
        ...applyLearningWikiGovernance(lowerMemory(spec), learning.learning !== undefined),
        ...continuity,
        // v0.3.0 Goal 3 — thredz is CARRIED on this shape (ignored-note in
        // the emitted bundle), not emit-wired yet.
        ...lowerThredzCarried(spec, continuity.continuity?.plan === true, "crew"),
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
      return {
        version: 0,
        name: spec.name,
        target: "research",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          ...(spec.agent.max_tokens !== undefined ? { maxTokens: spec.agent.max_tokens } : {}),
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent),
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
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
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
    case "batch":
      return {
        version: 0,
        name: spec.name,
        target: "batch",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          ...(spec.agent.max_tokens !== undefined ? { maxTokens: spec.agent.max_tokens } : {}),
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent),
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
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
        // Loop contract 0.4 (Batch F) — cron/interval wake trigger.
        ...lowerSchedule(spec.schedule),
        ...lowerChainSubsystem(spec),
      } satisfies IrBatchV0;
    case "voice":
      return {
        version: 0,
        name: spec.name,
        target: "voice",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
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
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
      } satisfies IrVoiceV0;
    case "browser":
      return {
        version: 0,
        name: spec.name,
        target: "browser",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          ...(spec.agent.max_tokens !== undefined ? { maxTokens: spec.agent.max_tokens } : {}),
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent),
        },
        driver: {
          backend: spec.driver.backend,
          viewport: { width: spec.driver.viewport.width, height: spec.driver.viewport.height },
          ...(spec.driver.startUrl !== undefined ? { startUrl: spec.driver.startUrl } : {}),
          // SECURITY — carried ONLY when the spec opts in, so every bundle
          // that leaves it at the default stays byte-identical to 0.4.1.
          ...(spec.driver.allowPrivateTargets ? { allowPrivateTargets: true } : {}),
        },
        groundingModel: spec.groundingModel ?? spec.agent.model,
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...lowerLimits(spec),
        ...lowerHooks(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
      } satisfies IrBrowserV0;
    case "eval":
      return {
        version: 0,
        name: spec.name,
        target: "eval",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          tools: spec.agent.tools ?? [],
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
    case "onchain": {
      const lowered = lowerChainSubsystem(spec);
      if (lowered.chains === undefined || lowered.chains.length === 0) {
        throw new Error("onchain target requires chains[] to be non-empty");
      }
      return {
        version: 0,
        name: spec.name,
        target: "onchain",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
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
        compaction: lowerCompaction(spec),
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
      return {
        version: 0,
        name: spec.name,
        target: "onchain-game",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
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
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
      } satisfies IrChainGameV0;
    }
    default:
      return assertNever(spec);
  }
}

function lowerCrewRole(name: string, role: SpecCrewRole, fallbackModel: string): IrCrewRole {
  return {
    name,
    model: role.model ?? fallbackModel,
    instructions: role.instructions,
    ...(role.max_tokens !== undefined ? { maxTokens: role.max_tokens } : {}),
    // Loop contract 0.4 (Batch A) — per-role thinking selector.
    ...lowerThinking(role.thinking),
    tools: role.tools ?? [],
    toolConfigs: lowerToolConfigs(role.tool_config),
    subAgents: lowerSubAgents(role.sub_agents),
    // Item 9 (G37) — per-role model routing (failover/tiers/pool), reusing the
    // cli agent block's lowering verbatim.
    ...lowerModelFailover(role),
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
