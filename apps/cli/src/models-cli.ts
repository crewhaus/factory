/**
 * 0.6.0 §8.2 / §9.1 — `crewhaus models list | explain | audit | propose`.
 *
 * The offline model-intelligence verb family. Everything here is PURE (no
 * filesystem, no network, no clock, no adapter construction): the CLI entry
 * file reads the spec, loads the installed pricing table, wires a parameter
 * projector over the real adapters, and prints what these functions return.
 *
 *   list     the resolved `models:` registry — one row per profile.
 *   explain  every model slot's resolved profile, the hybrid strategy as one
 *            sentence, and the per-shape carry/emit/ignore verdict (§11.3)
 *            for the spec's own shape.
 *   audit    every slot walked through {@link enumerateModelSlots}: pricing
 *            coverage, declared `requires:` against the capability table, and
 *            per-(provider, knob) PARAMETER ACCEPTANCE — projected through
 *            each adapter's own pure marshaller (`effectiveParams`, §8.1), so
 *            the silent temperature drop on Claude 5 is visible offline.
 *   propose  the sunset loop's patch bundle (`audit --propose`) and the
 *            audition roster proposal (`propose --source audition`).
 *
 * EXIT CODES (`audit`). `--fail-on <level>` is a LADDER, not a switch:
 *
 *   none     never exits non-zero — a report.
 *   pricing  (default) exits 1 on breakage that is true TODAY: a pricing
 *            miss, a `requires:` the capability table says the model cannot
 *            satisfy, a parameter the provider rejects outright, and a
 *            compiled-in sunset whose `retiresOn` is already past relative to
 *            `--today` (a retired model is not an advisory — it 404s).
 *   sunset   additionally exits 1 on an ANNOUNCED but not-yet-past sunset.
 *
 * `doctor --models` keeps its documented contract that a warn never fails
 * (§8.2) — the exit-code ladder lives HERE, in the new verb, so no
 * wall-clock date can redden a pinned `doctor --models` beat. Feed-sourced
 * sunsets are warn-only at every level, so `pricing sync`ing a feed can never
 * flip an exit code.
 */
import type { EffectiveParams } from "@crewhaus/adapter-anthropic";
import type {
  CapabilityRequirement,
  CapabilityTable,
  PricingTable,
  SunsetEntry,
  SunsetTable,
} from "@crewhaus/cost-tracker";
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_PRICING,
  KNOWN_SUNSETS,
  findSunset,
  resolveCapabilities,
  resolvePricing,
  satisfiesCapabilities,
  sunsetRetired,
} from "@crewhaus/cost-tracker";
import type { IrModelProfile, IrModelProfiles, IrNode } from "@crewhaus/ir";
import { parsedModelForTables } from "./model-scan";
import { type EnumeratedModelSlot, enumerateModelSlots } from "./model-slots";

/** Thrown on a malformed `crewhaus models …` invocation. */
export class ModelsCliError extends Error {
  override readonly name = "ModelsCliError";
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export type ModelsFailOn = "none" | "pricing" | "sunset";

export type ModelsArgs = {
  readonly sub: "list" | "explain" | "audit" | "propose";
  /** Spec path positional (the CLI defaults it to the cwd `crewhaus.yaml`). */
  readonly spec?: string;
  readonly json?: boolean;
  /** `audit --fail-on <level>` — the exit-code ladder (default `pricing`). */
  readonly failOn: ModelsFailOn;
  /** `audit --today YYYY-MM-DD` — pin the clock the sunset check reads. */
  readonly today?: string;
  /** `audit --propose` — emit a replacement patch per retired slot. */
  readonly propose?: boolean;
  /** `propose --source <s>` — which loop produced the proposal. */
  readonly source?: string;
  /** `propose --min-n N` — the audition power floor (default 30). */
  readonly minN?: number;
  /** `--dir <root>` — the `.crewhaus` root the audition reads arms from. */
  readonly dir?: string;
  /** `-o <dir>` — where the propose bundle lands. */
  readonly out?: string;
};

const SUBS = ["list", "explain", "audit", "propose"] as const;
const FAIL_ON: ReadonlyArray<ModelsFailOn> = ["none", "pricing", "sunset"];
const TODAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MODELS_USAGE =
  "list | explain [<spec>] | audit [<spec>] [--fail-on none|pricing|sunset] [--today YYYY-MM-DD] [--propose] [-o <dir>] | propose [<spec>] --source sunset|audition|right-size|route [--min-n N] [--dir <root>] [-o <dir>]";

/** Parse everything after `crewhaus models`. */
export function parseModelsArgs(argv: readonly string[]): ModelsArgs {
  let sub: ModelsArgs["sub"] | undefined;
  let spec: string | undefined;
  let json = false;
  let failOn: ModelsFailOn = "pricing";
  let today: string | undefined;
  let propose = false;
  let source: string | undefined;
  let minN: number | undefined;
  let dir: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new ModelsCliError(`models: ${a} requires a value`);
      i++;
      return v;
    };
    if (sub === undefined && (SUBS as readonly string[]).includes(a)) {
      sub = a as ModelsArgs["sub"];
    } else if (a === "--json") {
      json = true;
    } else if (a === "--propose") {
      propose = true;
    } else if (a === "--fail-on") {
      const v = next();
      if (!FAIL_ON.includes(v as ModelsFailOn)) {
        throw new ModelsCliError(
          `models audit: --fail-on must be one of ${FAIL_ON.join("|")} (got "${v}")`,
        );
      }
      failOn = v as ModelsFailOn;
    } else if (a === "--today") {
      const v = next();
      if (!TODAY_RE.test(v)) {
        throw new ModelsCliError(`models audit: --today must be YYYY-MM-DD (got "${v}")`);
      }
      today = v;
    } else if (a === "--source") {
      source = next();
    } else if (a === "--min-n") {
      const v = Number.parseInt(next(), 10);
      if (!Number.isFinite(v) || v < 1) {
        throw new ModelsCliError("models propose: --min-n must be a positive integer");
      }
      minN = v;
    } else if (a === "--dir") {
      dir = next();
    } else if (a === "-o" || a === "--out") {
      out = next();
    } else if (!a.startsWith("-") && spec === undefined && sub !== undefined) {
      spec = a;
    } else {
      throw new ModelsCliError(`models: unknown argument "${a}" (expected: ${MODELS_USAGE})`);
    }
  }
  if (sub === undefined) {
    throw new ModelsCliError(`models: expected a subcommand (${MODELS_USAGE})`);
  }
  return {
    sub,
    ...(spec !== undefined ? { spec } : {}),
    ...(json ? { json } : {}),
    failOn,
    ...(today !== undefined ? { today } : {}),
    ...(propose ? { propose } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(minN !== undefined ? { minN } : {}),
    ...(dir !== undefined ? { dir } : {}),
    ...(out !== undefined ? { out } : {}),
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export type ProfileRow = {
  readonly name: string;
  readonly model: string;
  readonly tags: ReadonlyArray<string>;
  /** The settings the profile pins, as `key=value` strings (display order). */
  readonly pinned: ReadonlyArray<string>;
};

function pinnedOf(profile: IrModelProfile): string[] {
  const out: string[] = [];
  if (profile.maxTokens !== undefined) out.push(`max_tokens=${profile.maxTokens}`);
  if (profile.temperature !== undefined) out.push(`temperature=${profile.temperature}`);
  if (profile.thinking !== undefined) {
    out.push(
      "budgetTokens" in profile.thinking
        ? `thinking=${profile.thinking.budgetTokens}tok`
        : `thinking=${profile.thinking.effort}`,
    );
  }
  if (profile.tools !== undefined) out.push(`tools=[${profile.tools.join(",")}]`);
  if (profile.permissions !== undefined) out.push("permissions");
  if (profile.toolConfigs !== undefined) out.push("tool_config");
  if (profile.rateLimits !== undefined) out.push("rate_limits");
  if (profile.caching !== undefined) out.push(`caching=${profile.caching}`);
  if (profile.costCapUsdMicros !== undefined) {
    out.push(`cost.max_usd=${(profile.costCapUsdMicros / 1_000_000).toFixed(2)}`);
  }
  if (profile.requires !== undefined) out.push("requires");
  if (profile.capabilities !== undefined) out.push("capabilities");
  if (profile.fallbacks !== undefined) out.push(`fallbacks=${profile.fallbacks.length}`);
  if (profile.circuitBreaker !== undefined) out.push("circuit_breaker");
  if (profile.overlay !== undefined) out.push("instructions");
  if (profile.modelCallTimeoutMs !== undefined) {
    out.push(`model_call_timeout_ms=${profile.modelCallTimeoutMs}`);
  }
  return out;
}

/** The resolved registry as rows, sorted by profile name. */
export function buildProfileRows(ir: IrNode): ProfileRow[] {
  const registry = (ir as { readonly models?: IrModelProfiles }).models ?? {};
  return Object.keys(registry)
    .sort()
    .map((name) => {
      const p = registry[name] as IrModelProfile;
      return { name, model: p.model, tags: p.tags ?? [], pinned: pinnedOf(p) };
    });
}

export function formatModelsList(ir: IrNode): string {
  const rows = buildProfileRows(ir);
  if (rows.length === 0) {
    return [
      "No `models:` registry — this spec declares its model(s) inline.",
      "",
      "Declare one to reuse per-model settings across slots:",
      "",
      "  models:",
      "    fast:   { model: claude-haiku-4-5, tags: [cheap] }",
      "    strong: { model: claude-opus-5,    tags: [strong] }",
      "",
      "then reference it from any model slot as `$fast`. `crewhaus init --hybrid` writes one.",
    ].join("\n");
  }
  const lines = [
    `${"profile".padEnd(16)} ${"model".padEnd(30)} ${"tags".padEnd(16)} pins`,
    ...rows.map(
      (r) =>
        `${r.name.padEnd(16)} ${r.model.padEnd(30)} ${(r.tags.join(",") || "-").padEnd(16)} ${
          r.pinned.join(" ") || "-"
        }`,
    ),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// explain — including the §11.3 per-shape matrix
// ---------------------------------------------------------------------------

/** One shape's row of the §11.3 carry / emit / ignore matrix. */
export type ShapeModelSupport = {
  readonly registry: string;
  readonly profileRefs: string;
  readonly pool: string;
  readonly perProfileSurfaces: string;
  readonly cascade: string;
  readonly guideShadow: string;
  readonly committee: string;
  readonly consultEscalate: string;
  readonly perModelEvals: string;
  readonly note?: string;
};

const E = "emit-wired";
const NO = "not carried";
const NA = "n/a on this shape";

/**
 * §11.3, verbatim. `models explain` prints the row for the spec's OWN shape,
 * so the answer to "does my per-profile `tools:` do anything here" is one
 * command rather than a table lookup in the docs.
 */
export const SHAPE_MODEL_MATRIX: Readonly<Record<string, ShapeModelSupport>> = Object.freeze({
  cli: {
    registry: E,
    profileRefs: E,
    pool: E,
    perProfileSurfaces: E,
    cascade: E,
    guideShadow: E,
    committee: `${NO} (REPL: each turn is the one the user waits on)`,
    consultEscalate: E,
    perModelEvals: E,
  },
  workflow: {
    registry: E,
    profileRefs: `${E} (model, steps[].model, judge)`,
    pool: `${E} per step`,
    perProfileSurfaces: `${E} per step`,
    cascade: `${E} via judge + force`,
    guideShadow: E,
    committee: E,
    consultEscalate: E,
    perModelEvals: E,
  },
  channel: {
    registry: E,
    profileRefs: E,
    pool: `${E} (directives opt-in)`,
    perProfileSurfaces: E,
    cascade: E,
    guideShadow: E,
    committee: `${NO} (REPL semantics per inbound message)`,
    consultEscalate: E,
    perModelEvals: E,
  },
  graph: {
    registry: E,
    profileRefs: `${E} (model, nodes[].model, judge)`,
    pool: `${E} per node`,
    perProfileSurfaces: `${E} per node`,
    cascade: `${E} via judge nodes + force`,
    guideShadow: E,
    committee: E,
    consultEscalate: E,
    perModelEvals: E,
  },
  managed: {
    registry: E,
    profileRefs: E,
    pool: E,
    perProfileSurfaces: E,
    cascade: E,
    guideShadow: E,
    committee: NO,
    consultEscalate: E,
    perModelEvals: E,
  },
  pipeline: {
    registry: E,
    profileRefs: `${E} (agent.model)`,
    pool: "params/overlay only",
    perProfileSurfaces: `${NO} — the pipeline spec declares no \`tools:\``,
    cascade: NO,
    guideShadow: E,
    committee: NO,
    consultEscalate: `${NO} — scope decision, reported as model-plan-ignored-on-shape`,
    perModelEvals: NA,
  },
  crew: {
    registry: E,
    profileRefs: `${E} (model, roles[].model, routing.model, sub_agents)`,
    pool: `${E} per role`,
    perProfileSurfaces: `${E} per role`,
    cascade: NO,
    guideShadow: E,
    committee: E,
    consultEscalate: E,
    perModelEvals: NA,
  },
  research: {
    registry: E,
    profileRefs: E,
    pool: E,
    perProfileSurfaces: E,
    cascade: NO,
    guideShadow: E,
    committee: NO,
    consultEscalate: E,
    perModelEvals: NA,
  },
  batch: {
    registry: E,
    profileRefs: E,
    pool: E,
    perProfileSurfaces: E,
    cascade: NO,
    guideShadow: E,
    committee: NO,
    consultEscalate: E,
    perModelEvals: NA,
  },
  voice: {
    registry: `${E} (profile → model/params only; other fields warned per field)`,
    profileRefs: E,
    pool: `${NO} (no pool block)`,
    perProfileSurfaces: `${NO} — the realtime loop registers no tool catalog`,
    cascade: NO,
    guideShadow: NO,
    committee: NO,
    consultEscalate: NO,
    perModelEvals: NA,
  },
  browser: {
    registry: E,
    profileRefs: `${E} (agent.model, grounding_model)`,
    pool: E,
    perProfileSurfaces: E,
    cascade: NO,
    guideShadow: E,
    committee: NO,
    consultEscalate: E,
    perModelEvals: NA,
  },
  eval: {
    registry: E,
    profileRefs: `${E} (agent.model; graders.yaml per_model)`,
    pool: NO,
    perProfileSurfaces: NO,
    cascade: NO,
    guideShadow: NO,
    committee: NO,
    consultEscalate: NO,
    perModelEvals: `${E} (graders)`,
  },
  onchain: {
    registry: `${E} (profile → model/params only)`,
    profileRefs: E,
    pool: NO,
    perProfileSurfaces: NO,
    cascade: NO,
    guideShadow: NO,
    committee: NO,
    consultEscalate: NO,
    perModelEvals: NA,
  },
  "onchain-game": {
    registry: `${E} (profile → model/params only)`,
    profileRefs: E,
    pool: NO,
    perProfileSurfaces: NO,
    cascade: NO,
    guideShadow: NO,
    committee: NO,
    consultEscalate: NO,
    perModelEvals: NA,
  },
});

type PoolLike = {
  readonly policy: string;
  readonly candidates: ReadonlyArray<{
    readonly model: string;
    readonly tags: ReadonlyArray<string>;
  }>;
  readonly directives?: boolean;
  readonly rules?: ReadonlyArray<unknown>;
  readonly classifier?: { readonly model: string };
  readonly strategy?: {
    readonly cascade?: { readonly draft: string; readonly escalateTo: string };
    readonly guide?: { readonly model: string; readonly every?: string };
    readonly shadow?: { readonly candidate: string; readonly sampleRate?: number };
    readonly committee?: { readonly members: ReadonlyArray<string> };
    readonly modelDirected?: boolean;
    readonly maxEscalations?: number;
  };
  readonly reward?: { readonly qualitySource?: string };
};

function primaryPool(ir: IrNode): PoolLike | undefined {
  const agent = (ir as { readonly agent?: { readonly modelPool?: PoolLike } }).agent;
  return agent?.modelPool;
}

/**
 * The hybrid strategy as ONE sentence — the sentence `models explain` prints
 * and the one a reviewer reads on a routing PR. Deliberately prose, not a
 * dump: a reader who cannot restate the topology in a sentence cannot review
 * a change to it.
 */
export function describeStrategy(pool: PoolLike | undefined): string {
  if (pool === undefined) {
    return "No `model_pool` — every call serves the single declared model.";
  }
  const parts: string[] = [];
  const arms = pool.candidates
    .map((c) => (c.tags.length > 0 ? `${c.model} [${c.tags.join(",")}]` : c.model))
    .join(" / ");
  parts.push(
    `A ${pool.policy} pool of ${pool.candidates.length} arm(s) — ${arms} — picks the model per call`,
  );
  const s = pool.strategy;
  if (s?.cascade !== undefined) {
    parts.push(
      `drafting on \`${s.cascade.draft}\` and escalating to \`${s.cascade.escalateTo}\` when the judge fails the draft`,
    );
  }
  if (s?.guide !== undefined) {
    parts.push(`with a \`${s.guide.model}\` guide on ${s.guide.every ?? "first_turn"}`);
  }
  if (s?.shadow !== undefined) {
    parts.push(
      `auditioning \`${s.shadow.candidate}\` on ${((s.shadow.sampleRate ?? 0) * 100).toFixed(0)}% of turns (observe-only until \`route promote\`)`,
    );
  }
  if (s?.committee !== undefined) {
    parts.push(`polling a committee of ${s.committee.members.length} member(s)`);
  }
  if (s?.modelDirected === true) {
    parts.push("and the model itself may call Escalate/Consult");
  }
  if ((pool.rules?.length ?? 0) > 0) {
    parts.push(`after ${pool.rules?.length} deterministic rule(s) get first refusal`);
  }
  if (pool.classifier !== undefined) {
    parts.push(`with a \`${pool.classifier.model}\` classifier labelling each message`);
  }
  if (pool.directives === true) {
    parts.push("and a user `/model` directive overrides all of it");
  }
  const tail =
    pool.reward?.qualitySource !== undefined && pool.reward.qualitySource !== "none"
      ? ` Quality reaches the reward from \`${pool.reward.qualitySource}\`.`
      : " Quality does NOT reach the reward (`reward.quality_source: none`).";
  return `${parts.join(", ")}.${tail}`;
}

/** The full `models explain` report for one lowered spec. */
export function formatModelsExplain(ir: IrNode, slots: ReadonlyArray<EnumeratedModelSlot>): string {
  const lines: string[] = [];
  lines.push(`shape: ${ir.target}`);
  lines.push("");
  lines.push("slots:");
  const width = Math.max(...slots.map((s) => s.label.length), 8);
  for (const s of slots) {
    const profile = s.profile !== undefined ? ` ← $${s.profile}` : "";
    const params: string[] = [];
    if (s.maxTokens !== undefined) params.push(`max_tokens=${s.maxTokens}`);
    if (s.temperature !== undefined) params.push(`temperature=${s.temperature}`);
    if (s.thinking !== undefined) {
      params.push(
        "budgetTokens" in s.thinking
          ? `thinking=${s.thinking.budgetTokens}tok`
          : `thinking=${s.thinking.effort}`,
      );
    }
    if (s.requires !== undefined) params.push(`requires=${JSON.stringify(s.requires)}`);
    lines.push(
      `  ${s.label.padEnd(width)}  ${s.model}${profile}${params.length > 0 ? `  (${params.join(" ")})` : ""}`,
    );
  }
  lines.push("");
  lines.push("strategy:");
  lines.push(`  ${describeStrategy(primaryPool(ir))}`);
  lines.push("");
  lines.push("directives:");
  lines.push(
    "  A `/model <arm>` line is parsed at the typed input seams — the REPL's own input and the",
  );
  lines.push(
    "  single-turn seed — never inside the router, so a directive that arrives mid-transcript",
  );
  lines.push(
    "  (a tool result, a recalled memory, an MCP response) can never steer the route. It is",
  );
  lines.push(
    `  ${primaryPool(ir)?.directives === true ? "ENABLED on this spec" : "off on this spec (`model_pool.directives: true` enables it)"}.`,
  );
  lines.push("");
  const row = SHAPE_MODEL_MATRIX[ir.target];
  lines.push(`per-shape support (${ir.target}):`);
  if (row === undefined) {
    lines.push("  (no matrix row — this shape predates the §11.3 table)");
  } else {
    lines.push(`  models: registry            ${row.registry}`);
    lines.push(`  $profile on slots           ${row.profileRefs}`);
    lines.push(`  pool per-candidate/rules    ${row.pool}`);
    lines.push(`  per-profile tools/perms     ${row.perProfileSurfaces}`);
    lines.push(`  cascade                     ${row.cascade}`);
    lines.push(`  guide / shadow              ${row.guideShadow}`);
    lines.push(`  committee                   ${row.committee}`);
    lines.push(`  Consult / Escalate          ${row.consultEscalate}`);
    lines.push(`  per-model evals             ${row.perModelEvals}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export type ModelAuditKind = "pricing" | "capability" | "params" | "sunset";
export type ModelAuditSeverity = "pass" | "warn" | "fail";

export type ModelAuditFinding = {
  readonly slot: string;
  readonly model: string;
  readonly kind: ModelAuditKind;
  readonly severity: ModelAuditSeverity;
  readonly detail: string;
  /** Sunset findings only. */
  readonly retiresOn?: string;
  readonly replacement?: string;
  readonly retired?: boolean;
  readonly source?: "builtin" | "feed";
  /** The spec patch path a `--propose` replacement would rewrite. */
  readonly path?: ReadonlyArray<string>;
};

/**
 * Project the parameters an adapter would actually put on the wire for one
 * slot. Injected so `models audit` stays pure and credential-free: the CLI
 * wires each provider's own exported marshaller projection (§8.1's rule —
 * never re-derive the gate).
 */
export type ParamProjection = (input: {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly thinking?: { readonly type: "enabled"; readonly budgetTokens: number };
}) => EffectiveParams | undefined;

export type AuditModelSlotsOptions = {
  readonly pricing?: PricingTable;
  readonly capabilities?: CapabilityTable;
  readonly sunsets?: SunsetTable;
  /** The clock the sunset check reads (`--today`). Default: now. */
  readonly today?: Date;
  readonly project?: ParamProjection;
};

function requirementOf(slot: EnumeratedModelSlot): CapabilityRequirement | undefined {
  const r = slot.requires;
  if (r === undefined) return undefined;
  return {
    ...(r.tool_use !== undefined ? { tool_use: r.tool_use } : {}),
    ...(r.vision !== undefined ? { vision: r.vision } : {}),
    ...(r.thinking !== undefined ? { thinking: r.thinking } : {}),
    ...(r.web_search !== undefined ? { web_search: r.web_search } : {}),
    ...(r.contextWindowGte !== undefined ? { contextWindowGte: r.contextWindowGte } : {}),
    ...(r.maxOutputTokensGte !== undefined ? { maxOutputTokensGte: r.maxOutputTokensGte } : {}),
  };
}

/**
 * The whole audit, per slot: pricing coverage, `requires:` against the
 * capability table, per-(provider, knob) parameter acceptance, and the
 * sunset watch. Pure; the caller supplies tables, clock and projector.
 */
export function auditModelSlots(
  slots: ReadonlyArray<EnumeratedModelSlot>,
  opts: AuditModelSlotsOptions = {},
): ModelAuditFinding[] {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const capTable = opts.capabilities ?? DEFAULT_CAPABILITIES;
  const sunsets = opts.sunsets ?? KNOWN_SUNSETS;
  const today = opts.today ?? new Date();
  const out: ModelAuditFinding[] = [];

  for (const slot of slots) {
    const parsed = parsedModelForTables(slot.model);
    if (parsed === undefined) {
      out.push({
        slot: slot.label,
        model: slot.model,
        kind: "pricing",
        severity: "warn",
        detail:
          "routed to a provider outside the pricing/capability tables (local, azure, a named host, or unparseable) — cost tracking reports $0 and every capability is unknown; declare `capabilities:` on the profile to state what the model can do",
      });
      continue;
    }
    // --- pricing coverage
    const row = resolvePricing(pricing, parsed.provider, parsed.modelId);
    out.push(
      row === undefined
        ? {
            slot: slot.label,
            model: slot.model,
            kind: "pricing",
            severity: "fail",
            detail: `no pricing row for ${parsed.provider}/${parsed.modelId} — cost-tracker silently bills it $0, so every budget, reward and cost report understates this arm`,
          }
        : {
            slot: slot.label,
            model: slot.model,
            kind: "pricing",
            severity: "pass",
            detail: `$${row.inputPer1M}/1M in, $${row.outputPer1M}/1M out`,
          },
    );

    // --- declared `requires:` against the capability table
    const req = requirementOf(slot);
    const caps = resolveCapabilities(capTable, parsed.provider, parsed.modelId);
    if (req !== undefined) {
      if (caps === undefined) {
        out.push({
          slot: slot.label,
          model: slot.model,
          kind: "capability",
          severity: "warn",
          detail: `the capability table does not know ${parsed.provider}/${parsed.modelId}, so \`requires\` cannot be verified offline — the adapter's own features are the only gate`,
        });
      } else if (!satisfiesCapabilities(caps, req)) {
        out.push({
          slot: slot.label,
          model: slot.model,
          kind: "capability",
          severity: "fail",
          detail: `declares requires ${JSON.stringify(slot.requires)} but the capability table says ${parsed.provider}/${parsed.modelId} offers ${JSON.stringify(caps)}`,
        });
      } else {
        out.push({
          slot: slot.label,
          model: slot.model,
          kind: "capability",
          severity: "pass",
          detail: `satisfies requires ${JSON.stringify(slot.requires)}`,
        });
      }
    }

    // --- per-(provider, knob) parameter acceptance
    if (
      opts.project !== undefined &&
      (slot.temperature !== undefined || slot.thinking !== undefined)
    ) {
      const thinking =
        slot.thinking !== undefined && "budgetTokens" in slot.thinking
          ? { type: "enabled" as const, budgetTokens: slot.thinking.budgetTokens }
          : undefined;
      const projected = opts.project({
        provider: parsed.provider,
        model: parsed.modelId,
        maxTokens: slot.maxTokens ?? 4096,
        ...(slot.temperature !== undefined ? { temperature: slot.temperature } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
      });
      if (projected === undefined) {
        out.push({
          slot: slot.label,
          model: slot.model,
          kind: "params",
          severity: "warn",
          detail: `${parsed.provider} does not project its request parameters offline — the pinned knobs cannot be checked without a call`,
        });
      } else if (projected.dropped.length > 0) {
        const names = projected.dropped.join(", ");
        out.push({
          slot: slot.label,
          model: slot.model,
          kind: "params",
          severity: "fail",
          detail: `${parsed.provider}/${parsed.modelId} DROPS ${names} — the pinned value never reaches the wire, so the slot is not configured the way the spec reads${projected.notes !== undefined && projected.notes.length > 0 ? ` (${projected.notes.join("; ")})` : ""}`,
        });
      } else {
        out.push({
          slot: slot.label,
          model: slot.model,
          kind: "params",
          severity: "pass",
          detail: "every pinned parameter reaches the wire",
        });
      }
    }

    // --- sunset watch
    const sunset = findSunset(parsed.provider, parsed.modelId, sunsets);
    if (sunset !== undefined) {
      const retired = sunsetRetired(sunset, today);
      const fromFeed = sunset.source === "feed";
      out.push({
        slot: slot.label,
        model: slot.model,
        kind: "sunset",
        // A feed-sourced sunset is advisory at every level (§8.2) — a fetched
        // feed must never be able to flip an exit code.
        severity: retired && !fromFeed ? "fail" : "warn",
        detail: retired
          ? `RETIRED ${sunset.retiresOn} — migrate to ${sunset.replacement}${sunset.note !== undefined ? ` (${sunset.note})` : ""}${fromFeed ? " [from the installed pricing feed — advisory]" : ""}`
          : `retires ${sunset.retiresOn} — migrate to ${sunset.replacement}${sunset.note !== undefined ? ` (${sunset.note})` : ""}${fromFeed ? " [from the installed pricing feed]" : ""}`,
        retiresOn: sunset.retiresOn,
        replacement: sunset.replacement,
        retired,
        ...(sunset.source !== undefined ? { source: sunset.source } : {}),
        ...(slot.path !== undefined ? { path: slot.path } : {}),
      });
    }
  }
  return out;
}

/**
 * The exit code for a finished audit, under the `--fail-on` ladder documented
 * in this module's header. Never throws; `none` is always 0.
 */
export function modelsAuditExitCode(
  findings: ReadonlyArray<ModelAuditFinding>,
  failOn: ModelsFailOn,
): number {
  if (failOn === "none") return 0;
  const hardFail = findings.some((f) => f.severity === "fail");
  if (hardFail) return 1;
  if (failOn === "sunset") {
    const announced = findings.some(
      (f) => f.kind === "sunset" && f.retired !== true && f.source !== "feed",
    );
    if (announced) return 1;
  }
  return 0;
}

export function formatModelsAudit(
  findings: ReadonlyArray<ModelAuditFinding>,
  failOn: ModelsFailOn,
): string {
  if (findings.length === 0) return "No model slots found in this spec.";
  const glyph = (f: ModelAuditFinding): string =>
    f.severity === "fail" ? "✗" : f.severity === "warn" ? "~" : "✓";
  const lines = findings.map((f) => `${glyph(f)} ${f.slot} [${f.kind}] ${f.model}: ${f.detail}`);
  const fails = findings.filter((f) => f.severity === "fail").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  lines.push("");
  lines.push(
    `${findings.length} check(s) across ${new Set(findings.map((f) => f.slot)).size} slot(s): ${fails} failing, ${warns} advisory (--fail-on ${failOn}).`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// audit --propose: the sunset replacement bundle (§9.1, loop 4)
// ---------------------------------------------------------------------------

export type SunsetPatch = {
  readonly slot: string;
  readonly currentModel: string;
  readonly replacement: string;
  readonly retiresOn: string;
  readonly patch: {
    readonly op: "replace";
    readonly path: ReadonlyArray<string>;
    readonly value: string;
  };
};

export type SunsetProposalArtifact = {
  readonly kind: "model-sunset-proposal";
  readonly generatedAt: string;
  readonly patches: ReadonlyArray<SunsetPatch>;
  /** Slots whose model retires but that no patch can address. */
  readonly unaddressable: ReadonlyArray<{ readonly slot: string; readonly reason: string }>;
};

/**
 * Build the replacement patch per RETIRED slot: `enumerateModelSlots` +
 * `KNOWN_SUNSETS.replacement`, the candidate set fixed to the one
 * replacement so the right-size-style loop has exactly one thing to eval.
 * Roster members (`model_pool.candidates`, tiers, fallbacks) carry no spec
 * patch path by design — the roster is human-owned (§9.3) — so they are
 * reported as unaddressable with the reason, never silently dropped.
 */
export function buildSunsetProposal(
  findings: ReadonlyArray<ModelAuditFinding>,
  now: () => Date = () => new Date(),
): SunsetProposalArtifact {
  const patches: SunsetPatch[] = [];
  const unaddressable: Array<{ slot: string; reason: string }> = [];
  for (const f of findings) {
    if (f.kind !== "sunset" || f.retired !== true) continue;
    if (f.path === undefined || f.replacement === undefined || f.retiresOn === undefined) {
      unaddressable.push({
        slot: f.slot,
        reason:
          "the slot is roster membership (a pool candidate, a tier, or a fallback chain entry) — §9.3 keeps the roster human-owned, so the replacement must be hand-edited",
      });
      continue;
    }
    patches.push({
      slot: f.slot,
      currentModel: f.model,
      replacement: f.replacement,
      retiresOn: f.retiresOn,
      patch: { op: "replace", path: f.path, value: f.replacement },
    });
  }
  return {
    kind: "model-sunset-proposal",
    generatedAt: now().toISOString(),
    patches,
    unaddressable,
  };
}

// ---------------------------------------------------------------------------
// propose --source audition (§9.1, loop 2)
// ---------------------------------------------------------------------------

/** The shadow arm's audition verdict against the primary it shadowed. */
export type AuditionVerdict = {
  readonly ready: boolean;
  readonly reason: string;
  readonly shadowArm?: string;
  readonly primaryArm?: string;
  readonly shadowN: number;
  readonly primaryN: number;
  readonly shadowLowerBound?: number;
  readonly primaryMean?: number;
  readonly minN: number;
};

type ArmLike = {
  readonly routeKey: string;
  readonly model: string;
  readonly n: number;
  readonly meanReward: number;
  readonly varReward: number;
};

/**
 * Wilson-style lower bound on an arm's mean reward. Reward lives in [0,1]
 * (`computeReward`'s contract), so the same normal-approximation floor the
 * experiment ledger uses applies: mean − z·sqrt(var/n).
 */
export function armLowerBound(arm: ArmLike, z = 1.96): number {
  if (arm.n === 0) return 0;
  return arm.meanReward - z * Math.sqrt(Math.max(arm.varReward, 0) / arm.n);
}

/**
 * §9.1 loop 2 — is the shadow arm ready to be PROPOSED into the roster?
 *
 * The bar is deliberately conservative and deliberately NOT a promotion: it
 * decides only whether to open a PR. `minN` is the shipped power floor from
 * `apps/cli/src/experiment.ts` (30) — below it the interval is so wide that
 * "no difference" is the only honest reading, so the audition REFUSES rather
 * than proposing on noise.
 */
export function auditionReadiness(
  arms: ReadonlyArray<ArmLike>,
  opts: { readonly shadowArm: string; readonly primaryArm: string; readonly minN: number },
): AuditionVerdict {
  const fold = (name: string): { n: number; mean: number; varSum: number } => {
    const matching = arms.filter((a) => a.model === name);
    const n = matching.reduce((acc, a) => acc + a.n, 0);
    if (n === 0) return { n: 0, mean: 0, varSum: 0 };
    const mean = matching.reduce((acc, a) => acc + a.meanReward * a.n, 0) / n;
    const varSum = matching.reduce((acc, a) => acc + a.varReward * a.n, 0) / n;
    return { n, mean, varSum };
  };
  const shadow = fold(opts.shadowArm);
  const primary = fold(opts.primaryArm);
  const base = {
    shadowArm: opts.shadowArm,
    primaryArm: opts.primaryArm,
    shadowN: shadow.n,
    primaryN: primary.n,
    minN: opts.minN,
  };
  if (shadow.n < opts.minN) {
    return {
      ...base,
      ready: false,
      reason: `the audition has ${shadow.n} observation(s) for ${opts.shadowArm}; the power floor is ${opts.minN} (\`DEFAULT_MIN_EXPERIMENT_N\`). Below it the interval is wider than any difference it could show, so proposing a roster change would be proposing on noise.`,
    };
  }
  if (primary.n < opts.minN) {
    return {
      ...base,
      ready: false,
      reason: `the incumbent ${opts.primaryArm} has ${primary.n} observation(s); the power floor is ${opts.minN}. Both sides must clear it — a shadow beating an under-measured incumbent proves nothing.`,
    };
  }
  const lower = armLowerBound({
    routeKey: "",
    model: opts.shadowArm,
    n: shadow.n,
    meanReward: shadow.mean,
    varReward: shadow.varSum,
  });
  const ready = lower > primary.mean;
  return {
    ...base,
    ready,
    shadowLowerBound: lower,
    primaryMean: primary.mean,
    reason: ready
      ? `the shadow arm's 95% lower bound (${lower.toFixed(4)}) exceeds the incumbent's mean reward (${primary.mean.toFixed(4)}) over ${shadow.n}/${primary.n} observations — worth a roster PR`
      : `the shadow arm's 95% lower bound (${lower.toFixed(4)}) does not exceed the incumbent's mean reward (${primary.mean.toFixed(4)}) — keep auditioning`,
  };
}

/** The sunset entry a slot's model matches, for `--propose` reporting. */
export function sunsetFor(
  model: string,
  sunsets: SunsetTable = KNOWN_SUNSETS,
): SunsetEntry | undefined {
  const parsed = parsedModelForTables(model);
  if (parsed === undefined) return undefined;
  return findSunset(parsed.provider, parsed.modelId, sunsets);
}

export { enumerateModelSlots };
