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
  IrFailureTaxonomyEntry,
  IrFeedback,
  IrGraphV0,
  IrIMessageConfig,
  IrLearning,
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
  IrSecretRef,
  IrSecurity,
  IrSlackConfig,
  IrSubAgentDefinition,
  IrTelegramConfig,
  IrThredz,
  IrTransactionPolicy,
  IrV0,
  IrVoiceV0,
  IrWalletBinding,
  IrWhatsAppConfig,
  IrWorkflowV0,
} from "@crewhaus/ir";
import { applyPasses as applyIrPassesFn } from "@crewhaus/ir-passes";
import {
  type Spec,
  type SpecChannel,
  type SpecCrewRole,
  type SpecDiscordChannel,
  type SpecIMessageChannel,
  type SpecMcpServerConfig,
  type SpecSlackChannel,
  type SpecSubAgentDefinition,
  type SpecTelegramChannel,
  type SpecWhatsAppChannel,
  parseSpec,
} from "@crewhaus/spec";
import { emitBatchWorker } from "@crewhaus/target-batch-worker";
import { emitBrowserDriver } from "@crewhaus/target-browser-driver";
import { emitChannelBot } from "@crewhaus/target-channel-bot";
import { emitCli } from "@crewhaus/target-cli";
import { emitCrew } from "@crewhaus/target-crew";
import { emitEval } from "@crewhaus/target-eval-bundle";
import { emitGraph } from "@crewhaus/target-graph";
import { emitManaged } from "@crewhaus/target-managed";
import { emitOnchain } from "@crewhaus/target-onchain";
import { emitOnchainGame } from "@crewhaus/target-onchain-game";
import { emitPipeline } from "@crewhaus/target-pipeline";
import { emitResearchBundle } from "@crewhaus/target-research-bundle";
import { emitVoice } from "@crewhaus/target-voice";
import { emitWorkflow } from "@crewhaus/target-workflow";
import { type ScopeFinding, isOutwardName } from "@crewhaus/tool-builder";

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
};

export function compile(yamlText: string, opts: CompileOptions = {}): Bundle {
  const spec = parseSpec(yamlText);
  let ir = lower(spec);
  if (opts.strict === true) {
    assertToolScopesStrict(ir);
  }
  if (opts.applyIrPasses === true) {
    // Static import so the compiler bundles cleanly into a Cloudflare
    // Worker. ir-passes is a workspace dep regardless; the prior `require`
    // call broke Worker bundling (no `require` in CF Workers runtime).
    ir = applyIrPassesFn(ir);
  }
  return emit(ir, { readme: opts.readme !== false });
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
  }));
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
    readonly ttl?: string;
    readonly autoCapture?: boolean;
    readonly autoCaptureThreshold?: number;
    readonly autoRecall?: boolean;
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
 *  compile time. LOAD-BEARING here, mirrored (validation-only) by
 *  ir-passes' `memoryIntegrityPass` for direct-IR builders — the passes are
 *  opt-in and skipped on the plain compile path. */
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
  return {
    memory: {
      ...(m.enabled !== undefined ? { enabled: m.enabled } : {}),
      ...(m.backend !== undefined ? { backend: m.backend } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(m.autoCapture !== undefined ? { autoCapture: m.autoCapture } : {}),
      ...(m.autoCaptureThreshold !== undefined
        ? { autoCaptureThreshold: m.autoCaptureThreshold }
        : {}),
      ...(m.autoRecall !== undefined ? { autoRecall: m.autoRecall } : {}),
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
 * (channel) — LOAD-BEARING validation lives here (the ir-passes mirror is
 * opt-in and skipped on the plain compile path). Every other field is
 * resolved to its default so the IR carries one deterministic shape.
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
/** Exact pin (design §4.1): the published stdio server whose v0.2.0 tool
 *  contract (25 tools incl. `goal_*`/`task_*`, `THREDZ_DEFAULT_VISIBILITY`)
 *  the wiring layer is built against. */
export const THREDZ_MCP_PACKAGE_SPEC = "thredz-mcp@0.2.0";

type SpecThredz =
  | boolean
  | string
  | {
      readonly api_key: string;
      readonly base_url?: string;
      readonly visibility?: "private" | "shared";
      readonly goals?: boolean;
      readonly agents?: boolean | string;
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
    goals: obj.goals ?? continuityGoalsOn,
    ...(agentName !== undefined ? { agentName } : {}),
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
    },
  };
}

/**
 * The emit-WIRED lowering (cli shape): resolve the block, synthesize the MCP
 * server (unless the user declared their own `mcp_servers.thredz` — explicit
 * beats implicit; `crewhaus lint` warns about the shadowing), and flip
 * `memory.backend` to `thredz` on a declared memory block. Cross-field
 * validation lives here (LOAD-BEARING — ir-passes are opt-in and skipped on
 * the plain compile path):
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
 * The CARRIED lowering (channel/managed/research/crew): the block parses and
 * lowers to `IrThredz` so recompiles round-trip, but nothing is synthesized
 * or flipped — those emitters print the 0.2.3-convention ignored-note
 * comment instead of half-wiring a backend their daemons cannot boot yet.
 * An explicit `memory.backend: thredz` is rejected loudly (dead config that
 * would degrade-warn every run beats nobody's use case).
 */
function lowerThredzCarried(
  spec: SpecWithThredz,
  continuityGoalsOn: boolean,
  shape: string,
): { thredz?: IrThredz } {
  if (spec.memory?.backend === "thredz") {
    throw new CompilerError(
      `memory.backend "thredz" is emit-wired on the cli shape only in this release — the ${shape} shape carries the thredz: block for forward compatibility but keeps the local backend. Remove the backend override.`,
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
 * validation lives HERE (LOAD-BEARING — ir-passes are opt-in and skipped on
 * the plain compile path), mirrored by ir-passes' `memoryIntegrityPass` for
 * direct-IR builders:
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

type SpecWithObservability = {
  readonly observability?: {
    readonly slo?: {
      readonly error_rate?: number;
      readonly p95_latency_ms?: number;
      readonly ttft_ms?: number;
      readonly cost_per_hour_usd?: number;
      readonly egress_block_rate?: number;
      readonly window_seconds?: number;
      readonly mitigation?: ReadonlyArray<"alert" | "pause-intake" | "rollback">;
    };
  };
};

/**
 * Ops item 37 — lower the cross-cutting `observability` block, mirroring
 * lowerMemory's spread-return-{} discipline (Pillar 1): the key is absent from
 * the IR when the spec omits the block. `slo.window_seconds` is folded to
 * `windowMs` (ms) at lower time so the runtime monitor reads a literal duration;
 * `mitigation` defaults to `["alert"]` here so an observe-only spec that lists
 * thresholds without a ladder still warns (the safe rung). Targets are carried
 * verbatim from snake_case spec keys to camelCase IR keys.
 */
function lowerObservability(spec: SpecWithObservability): { observability?: IrObservability } {
  const o = spec.observability;
  if (o === undefined) return {};
  const slo = o.slo;
  if (slo === undefined) return { observability: {} };
  return {
    observability: {
      slo: {
        ...(slo.error_rate !== undefined ? { errorRate: slo.error_rate } : {}),
        ...(slo.p95_latency_ms !== undefined ? { p95LatencyMs: slo.p95_latency_ms } : {}),
        ...(slo.ttft_ms !== undefined ? { ttftMs: slo.ttft_ms } : {}),
        ...(slo.cost_per_hour_usd !== undefined ? { costPerHourUsd: slo.cost_per_hour_usd } : {}),
        ...(slo.egress_block_rate !== undefined ? { egressBlockRate: slo.egress_block_rate } : {}),
        ...(slo.window_seconds !== undefined ? { windowMs: slo.window_seconds * 1000 } : {}),
        mitigation: slo.mitigation !== undefined ? [...slo.mitigation] : ["alert"],
      },
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
        ...lowerSecurity(spec),
        ...lowerFeedback(spec),
        ...memoryLowered,
        ...continuity,
        ...(thredzLowered.thredz !== undefined ? { thredz: thredzLowered.thredz } : {}),
        ...learning,
        ...lowerObservability(spec),
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
                ...(spec.cli.tui !== "basic" ? { tui: spec.cli.tui } : {}),
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
        steps: spec.steps.map((s) => ({
          name: s.name,
          instructions: s.instructions,
          model: s.model ?? spec.model,
          tools: s.tools ?? [],
          toolConfigs: lowerToolConfigs(s.tool_config),
        })),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
        ...lowerChainSubsystem(spec),
      } satisfies IrWorkflowV0;
    case "channel": {
      const continuity = lowerContinuity(spec, { defaultOn: true, autoScope: "session" });
      // v0.3.0 Goal 2 — learning (validated + Sources-required wiki stamp).
      const learning = lowerLearning(spec);
      return {
        version: 0,
        name: spec.name,
        target: "channel",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          ...lowerModelFailover(spec.agent),
        },
        tools: spec.agent.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.agent.tool_config),
        channels: lowerChannels(spec.channels),
        routing: { sessionKey: spec.routing.sessionKey },
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...lowerFeedback(spec),
        ...applyLearningWikiGovernance(lowerMemory(spec), learning.learning !== undefined),
        // v0.3.0 Goal 1 — DEFAULT-ON continuity. `auto` scope resolves to
        // `session` on channel: per-conversation stores ride the session
        // router's sessionId (§2.7/§14.5); heartbeat ticks read spec scope.
        ...continuity,
        // v0.3.0 Goal 3 — thredz is CARRIED on this shape (ignored-note in
        // the emitted daemon), not emit-wired yet.
        ...lowerThredzCarried(spec, continuity.continuity?.plan === true, "channel"),
        ...learning,
        ...lowerObservability(spec),
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
        nodes: Object.entries(spec.nodes).map(([name, node]) => ({
          name,
          instructions: node.instructions,
          model: node.model ?? spec.model,
          tools: node.tools ?? [],
          toolConfigs: lowerToolConfigs(node.tool_config),
          ...(node.hitl !== undefined ? { hitlPrompt: node.hitl.prompt } : {}),
        })),
        edges: spec.edges.map((e) => ({ from: e.from, to: e.to })),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerChainSubsystem(spec),
      } satisfies IrGraphV0;
    case "managed": {
      const continuity = lowerContinuity(spec, { defaultOn: true, autoScope: "spec" });
      // v0.3.0 Goal 2 — learning (validated + Sources-required wiki stamp).
      const learning = lowerLearning(spec);
      return {
        version: 0,
        name: spec.name,
        target: "managed",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
          ...lowerModelFailover(spec.agent),
        },
        tenants: spec.tenants.map((t) => ({
          id: t.id,
          budget: {
            maxInputTokens: t.budget.maxInputTokens,
            maxOutputTokens: t.budget.maxOutputTokens,
          },
        })),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
        ...lowerBudget(spec),
        ...applyLearningWikiGovernance(lowerMemory(spec), learning.learning !== undefined),
        // v0.3.0 Goal 1 — DEFAULT-ON continuity. `auto` resolves to `spec`
        // scope; the managed daemon tenant-fences every store at boot (the
        // wireMemory deps carry the tenant, §2.7).
        ...continuity,
        // v0.3.0 Goal 3 — thredz is CARRIED on this shape (ignored-note in
        // the emitted daemon), not emit-wired yet.
        ...lowerThredzCarried(spec, continuity.continuity?.plan === true, "managed"),
        ...learning,
        ...lowerObservability(spec),
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
        // v0.3.0 — crew joins the memory-carrying shapes (§9) and gets
        // DEFAULT-ON continuity: roles share the `spec`-scoped plan store
        // (the plan IS the coordination surface, §2.7).
        ...applyLearningWikiGovernance(lowerMemory(spec), learning.learning !== undefined),
        ...continuity,
        // v0.3.0 Goal 3 — thredz is CARRIED on this shape (ignored-note in
        // the emitted bundle), not emit-wired yet.
        ...lowerThredzCarried(spec, continuity.continuity?.plan === true, "crew"),
        ...learning,
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
        // v0.3.0 — carried only when declared (NOT default-on); the emitter
        // prints the ignored-note comment.
        ...lowerContinuity(spec, { defaultOn: false, autoScope: "spec" }),
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
          // Adaptive model routing — lowers model_pool when declared.
          ...lowerModelFailover(spec.agent),
        },
        driver: {
          backend: spec.driver.backend,
          viewport: { width: spec.driver.viewport.width, height: spec.driver.viewport.height },
          ...(spec.driver.startUrl !== undefined ? { startUrl: spec.driver.startUrl } : {}),
        },
        groundingModel: spec.groundingModel ?? spec.agent.model,
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
        ...lowerFailureTaxonomy(spec),
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
    tools: role.tools ?? [],
    toolConfigs: lowerToolConfigs(role.tool_config),
    subAgents: lowerSubAgents(role.sub_agents),
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
