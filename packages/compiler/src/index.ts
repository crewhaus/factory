import { assertNever } from "@crewhaus/infra-utils";
import type {
  Bundle,
  IrBatchV0,
  IrBrowserV0,
  IrChainBinding,
  IrChainFinality,
  IrChainGameV0,
  IrChainV0,
  IrChannelV0,
  IrChannels,
  IrCompaction,
  IrContractBinding,
  IrCrewRole,
  IrCrewV0,
  IrDiscordConfig,
  IrEvalV0,
  IrGraphV0,
  IrIMessageConfig,
  IrManagedV0,
  IrMcpServerConfig,
  IrMcpServers,
  IrNode,
  IrPermissions,
  IrPipelineV0,
  IrResearchV0,
  IrSecretRef,
  IrSlackConfig,
  IrSubAgentDefinition,
  IrTelegramConfig,
  IrTransactionPolicy,
  IrV0,
  IrVoiceV0,
  IrWalletBinding,
  IrWhatsAppConfig,
  IrWorkflowV0,
} from "@crewhaus/ir";
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
};

export function compile(yamlText: string, opts: CompileOptions = {}): Bundle {
  const spec = parseSpec(yamlText);
  let ir = lower(spec);
  if (opts.applyIrPasses === true) {
    // Lazy import to avoid pulling ir-passes into bundles that don't ask.
    const { applyPasses } = require("@crewhaus/ir-passes") as typeof import("@crewhaus/ir-passes");
    ir = applyPasses(ir);
  }
  return emit(ir);
}

type SpecWithPermissions = Exclude<Spec, { target: "eval" }>;
/**
 * Phase 3 §3.1 — parse a heartbeat duration string ("2h", "30m",
 * "60s", "500ms") to milliseconds. Caller is expected to have already
 * regex-validated the format at the spec layer; this is the
 * deterministic numeric step.
 */
function parseDurationToMs(duration: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(duration);
  if (!m) {
    throw new Error(`invalid duration "${duration}" (caught past spec validation)`);
  }
  const n = Number.parseInt(m[1] ?? "0", 10);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    default:
      throw new Error(`unreachable duration unit "${m[2]}"`);
  }
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
 * The shape is otherwise identical so target codegen can JSON-stringify
 * the IR config directly into the emitted bundle.
 */
function lowerMcpServers(specMcp: Record<string, SpecMcpServerConfig> | undefined): IrMcpServers {
  if (specMcp === undefined) return Object.freeze({}) as IrMcpServers;
  const out: Record<string, IrMcpServerConfig> = {};
  for (const [name, cfg] of Object.entries(specMcp)) {
    if (cfg.transport === "stdio") {
      out[name] = {
        transport: "stdio",
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.env !== undefined ? { env: cfg.env } : {}),
      };
    } else {
      out[name] = {
        transport: "sse",
        url: cfg.url,
        ...(cfg.headers !== undefined ? { headers: cfg.headers } : {}),
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

function lowerSlack(slack: SpecSlackChannel): IrSlackConfig {
  return {
    botToken: lowerSecret(slack.botToken),
    signingSecret: lowerSecret(slack.signingSecret),
    ...(slack.appToken !== undefined ? { appToken: lowerSecret(slack.appToken) } : {}),
  };
}

function lowerTelegram(telegram: SpecTelegramChannel): IrTelegramConfig {
  return {
    botToken: lowerSecret(telegram.botToken),
    secretToken: lowerSecret(telegram.secretToken),
  };
}

function lowerDiscord(discord: SpecDiscordChannel): IrDiscordConfig {
  return {
    applicationId: lowerSecret(discord.applicationId),
    botToken: lowerSecret(discord.botToken),
    publicKeyHex: lowerSecret(discord.publicKeyHex),
  };
}

function lowerWhatsApp(whatsapp: SpecWhatsAppChannel): IrWhatsAppConfig {
  return {
    phoneNumberId: lowerSecret(whatsapp.phoneNumberId),
    accessToken: lowerSecret(whatsapp.accessToken),
    appSecret: lowerSecret(whatsapp.appSecret),
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
  if (c.model !== undefined) out.model = c.model;
  if (c.curate !== undefined) out.curate = c.curate;
  if (c.dedupeThreshold !== undefined) out.dedupeThreshold = c.dedupeThreshold;
  if (c.relevanceTopK !== undefined) out.relevanceTopK = c.relevanceTopK;
  return out;
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
      ...(w.keyRef !== undefined ? { keyRef: lowerSecret(w.keyRef) } : {}),
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
      allowedContracts: [...tp.allowedContracts],
      simulationRequired: tp.simulationRequired,
    };
  }
  return out;
}

export function lower(spec: Spec): IrNode {
  switch (spec.target) {
    case "cli":
      return {
        version: 0,
        name: spec.name,
        target: "cli",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
        },
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents),
        compaction: lowerCompaction(spec),
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
        ...lowerChainSubsystem(spec),
      } satisfies IrWorkflowV0;
    case "channel":
      return {
        version: 0,
        name: spec.name,
        target: "channel",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
        },
        tools: spec.agent.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.agent.tool_config),
        channels: lowerChannels(spec.channels),
        routing: { sessionKey: spec.routing.sessionKey },
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents),
        compaction: lowerCompaction(spec),
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
        ...lowerChainSubsystem(spec),
      } satisfies IrGraphV0;
    case "managed":
      return {
        version: 0,
        name: spec.name,
        target: "managed",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
        tenants: spec.tenants.map((t) => ({
          id: t.id,
          budget: {
            maxInputTokens: t.budget.maxInputTokens,
            maxOutputTokens: t.budget.maxOutputTokens,
          },
        })),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
      } satisfies IrManagedV0;
    case "pipeline":
      return {
        version: 0,
        name: spec.name,
        target: "pipeline",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
        retrieve: {
          embedderModel: spec.retrieve.embedderModel,
          vectorBackend: spec.retrieve.vectorBackend,
          defaultK: spec.retrieve.defaultK,
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
      } satisfies IrPipelineV0;
    case "crew":
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
        ...lowerChainSubsystem(spec),
      } satisfies IrCrewV0;
    case "research":
      return {
        version: 0,
        name: spec.name,
        target: "research",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
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
        ...lowerChainSubsystem(spec),
      } satisfies IrResearchV0;
    case "batch":
      return {
        version: 0,
        name: spec.name,
        target: "batch",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
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
      } satisfies IrVoiceV0;
    case "browser":
      return {
        version: 0,
        name: spec.name,
        target: "browser",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
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
      } satisfies IrChainV0;
    }
    case "onchain-game": {
      // onchain-game inlines a single chain/wallet/contract, so we lower
      // each one through the shared helpers and then assemble.
      const lowered = lowerChainSubsystem({
        chains: [spec.chain],
        wallets: [spec.wallet],
        contracts: [spec.game.contract],
        transaction_policy: spec.transaction_policy,
      });
      const chain = lowered.chains?.[0];
      const wallet = lowered.wallets?.[0];
      const contract = lowered.contracts?.[0];
      if (chain === undefined || wallet === undefined || contract === undefined) {
        throw new Error("onchain-game lowering failed to produce chain/wallet/contract");
      }
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

function emit(ir: IrNode): Bundle {
  switch (ir.target) {
    case "cli":
      return emitCli(ir);
    case "workflow":
      return emitWorkflow(ir);
    case "channel":
      return emitChannelBot(ir);
    case "graph":
      return emitGraph(ir);
    case "managed":
      return emitManaged(ir);
    case "pipeline":
      return emitPipeline(ir);
    case "crew":
      return emitCrew(ir);
    case "research":
      return emitResearchBundle(ir);
    case "batch":
      return emitBatchWorker(ir);
    case "voice":
      return emitVoice(ir);
    case "browser":
      return emitBrowserDriver(ir);
    case "eval":
      return emitEval(ir);
    case "onchain":
      return emitOnchain(ir);
    case "onchain-game":
      return emitOnchainGame(ir);
    default:
      return assertNever(ir);
  }
}

export type { Bundle, IrV0, IrWorkflowV0, IrChannelV0, IrNode } from "@crewhaus/ir";
export { type Spec, parseSpec, SpecParseError } from "@crewhaus/spec";
