/**
 * 0.6.0 §9.2 — `crewhaus upgrade --hoist-models`: lift repeated
 * `{model, thinking, max_tokens}` triples that appear on two or more model
 * slots into `models:` profiles, rewrite the slots to `$refs`, and show the
 * diff. Opt-in and a PROPOSAL by default: the CLI wrapper applies the
 * rewritten text only under `--write`.
 *
 * Why a triple and not "every model slot": the profile registry exists so a
 * setting is declared ONCE. Hoisting is worthwhile exactly when the same
 * settings are spelled out in several places; a model that appears once
 * gains nothing from a profile and is left alone. Slots hoisted are the ones
 * whose block natively carries the triple — `agent`, `agent.sub_agents.<n>`,
 * workflow `steps[i]`, graph `nodes.<n>`, crew `roles.<n>` — plus every
 * `model_pool.candidates[i]` (inline candidates carry the same fields).
 * Auxiliary single-model slots (`compaction.model`, judge models, tiers,
 * fallbacks) are NOT hoisted: on those the compiler folds a profile's
 * thinking / max_tokens into the consumer's own request params, which the
 * un-hoisted spec never carried, so the lowered IR would not be identical.
 *
 * Profiles are NAMED BY PRICE RANK (cheapest first): `fast` / `strong` for
 * two, `fast` / `balanced` / `strong` for three, `tier-N` in between beyond
 * that, `default` when only one triple repeats. Unpriceable models (local /
 * azure / named hosts) rank last in declaration order.
 *
 * ARM IDENTITY (§7.9, §9.2): a pool candidate's scoreboard arm id is the
 * model string today and the PROFILE NAME once it references one. Hoisting a
 * candidate therefore changes its arm id, and `arms.jsonl` history under the
 * old id would be orphaned. The plan reports every such rewrite; the CLI
 * wrapper either re-keys the lines (`--rewrite-arms`, a write-then-rename
 * single-writer swap via {@link rewriteArmsFile}) or prints the
 * "learned history reset" note — it never orphans arms silently.
 *
 * The IR-equality contract — the hoisted spec lowers to the same IR as the
 * source, modulo the provenance the registry adds (`models`, `modelProfile`,
 * a candidate's `profile`) — is pinned in `hoist-models.test.ts`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  DEFAULT_PRICING,
  type PricingTable,
  blendedPer1M,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import { type SpecObject, findModelPools } from "@crewhaus/migration-engine";
import { SPEC_PROFILE_NAME_RE } from "@crewhaus/spec";
import {
  type SpecDiffEntry,
  type SpecEdit,
  applySpecEdits,
  diffSpecYaml,
} from "@crewhaus/spec-patch";
import { parse as parseYaml } from "yaml";
import { parsedModelForTables } from "./model-scan";

export type HoistPathSegment = string | number;

/** One model-bearing block the planner considered. */
export type HoistSlot = {
  /** Path from the spec root to the BLOCK carrying `model` / `thinking` / `max_tokens`. */
  readonly path: ReadonlyArray<HoistPathSegment>;
  /** Human label (`agent`, `steps[0]`, `roles.writer`, `agent.model_pool.candidates[1]`). */
  readonly label: string;
  /** `candidate` slots change a scoreboard arm id when hoisted. */
  readonly kind: "slot" | "candidate";
  readonly model: string;
  readonly thinking?: Record<string, unknown>;
  readonly max_tokens?: number;
};

/** One profile the plan introduces, with the slots it replaces. */
export type HoistProfile = {
  readonly name: string;
  readonly model: string;
  readonly thinking?: Record<string, unknown>;
  readonly max_tokens?: number;
  /** Blended $/1M used for the rank; absent for unpriceable models. */
  readonly pricePer1M?: number;
  readonly slots: ReadonlyArray<HoistSlot>;
};

export type HoistArmRewrite = {
  /** The candidate's model string — its arm id before hoisting. */
  readonly model: string;
  /** The profile name — its arm id after hoisting. */
  readonly profile: string;
};

export type HoistPlan = {
  readonly action: "hoist" | "nothing-to-hoist";
  /** Why nothing was hoisted (`action: "nothing-to-hoist"`). */
  readonly reason?: string;
  readonly profiles: ReadonlyArray<HoistProfile>;
  readonly edits: ReadonlyArray<SpecEdit>;
  /** The rewritten YAML (comment- and key-order-preserving); the input when nothing was hoisted. */
  readonly yaml: string;
  readonly diff: ReadonlyArray<SpecDiffEntry>;
  /** Candidate arm-id changes the caller must handle (rewrite or reset note). */
  readonly armRewrites: ReadonlyArray<HoistArmRewrite>;
};

export type PlanHoistModelsOptions = {
  /** Pricing table for the rank; defaults to the built-in table. */
  readonly pricing?: PricingTable;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SENTINELS: ReadonlySet<string> = new Set(["cheapest", "strongest"]);

function labelOf(path: ReadonlyArray<HoistPathSegment>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? seg : `.${seg}`;
  }
  return out;
}

/** A block qualifies when its `model` is a concrete grammar string (not a `$ref`, not a sentinel). */
function slotFrom(
  path: ReadonlyArray<HoistPathSegment>,
  block: unknown,
  kind: HoistSlot["kind"],
): HoistSlot | undefined {
  if (!isRecord(block)) return undefined;
  const model = block["model"];
  if (typeof model !== "string" || model.startsWith("$") || SENTINELS.has(model)) return undefined;
  const thinking = block["thinking"];
  const maxTokens = block["max_tokens"];
  return {
    path,
    label: labelOf(path),
    kind,
    model,
    ...(isRecord(thinking) ? { thinking } : {}),
    ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
  };
}

/** Every block whose triple the planner may hoist, in declaration order. */
export function enumerateHoistSlots(spec: SpecObject): ReadonlyArray<HoistSlot> {
  const out: HoistSlot[] = [];
  const push = (s: HoistSlot | undefined): void => {
    if (s !== undefined) out.push(s);
  };
  const agent = spec["agent"];
  push(slotFrom(["agent"], agent, "slot"));
  if (isRecord(agent) && isRecord(agent["sub_agents"])) {
    for (const [name, def] of Object.entries(agent["sub_agents"])) {
      push(slotFrom(["agent", "sub_agents", name], def, "slot"));
    }
  }
  if (Array.isArray(spec["steps"])) {
    spec["steps"].forEach((step, i) => push(slotFrom(["steps", i], step, "slot")));
  }
  for (const mapKey of ["nodes", "roles"] as const) {
    const map = spec[mapKey];
    if (!isRecord(map)) continue;
    for (const [name, block] of Object.entries(map)) push(slotFrom([mapKey, name], block, "slot"));
  }
  for (const site of findModelPools(spec)) {
    const candidates = site.pool["candidates"];
    if (!Array.isArray(candidates)) continue;
    candidates.forEach((c, i) => push(slotFrom([...site.path, "candidates", i], c, "candidate")));
  }
  return out;
}

/** Stable signature of a triple — the grouping key. */
function signatureOf(slot: HoistSlot): string {
  return JSON.stringify([
    slot.model,
    slot.thinking === undefined ? null : canonicalJson(slot.thinking),
    slot.max_tokens ?? null,
  ]);
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function priceOf(model: string, pricing: PricingTable): number | undefined {
  const parsed = parsedModelForTables(model);
  if (parsed === undefined) return undefined;
  const row = resolvePricing(pricing, parsed.provider, parsed.modelId);
  return row === undefined ? undefined : blendedPer1M(row);
}

/** Rank-position names: cheapest first. */
function rankNames(count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return ["default"];
  if (count === 2) return ["fast", "strong"];
  if (count === 3) return ["fast", "balanced", "strong"];
  const names = ["fast"];
  for (let i = 2; i < count; i++) names.push(`tier-${i}`);
  names.push("strong");
  return names;
}

/** Avoid clobbering a declared profile: suffix until the name is free. */
function freeName(base: string, taken: Set<string>): string {
  let name = base;
  let n = 2;
  while (taken.has(name) || !SPEC_PROFILE_NAME_RE.test(name)) {
    name = `${base}-${n}`;
    n += 1;
  }
  taken.add(name);
  return name;
}

/**
 * Plan the hoist for a spec's YAML text. Pure: returns the rewritten text
 * (never writes), or `nothing-to-hoist` with the reason. Throws
 * `SpecPatchError` when the rewritten spec fails the live schema — which
 * cannot happen for a triple the schema already accepted inline, so a throw
 * here is a planner bug, not user error.
 */
export function planHoistModels(yamlText: string, opts: PlanHoistModelsOptions = {}): HoistPlan {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const nothing = (reason: string): HoistPlan => ({
    action: "nothing-to-hoist",
    reason,
    profiles: [],
    edits: [],
    yaml: yamlText,
    diff: [],
    armRewrites: [],
  });
  const parsed = parseYaml(yamlText) as unknown;
  if (!isRecord(parsed)) return nothing("spec is not a YAML mapping");
  const spec = parsed as SpecObject;

  // Group by triple; keep only groups with two or more slots.
  const groups = new Map<string, HoistSlot[]>();
  for (const slot of enumerateHoistSlots(spec)) {
    const key = signatureOf(slot);
    const g = groups.get(key) ?? [];
    g.push(slot);
    groups.set(key, g);
  }
  const repeated = [...groups.values()].filter((g) => g.length >= 2);
  if (repeated.length === 0) {
    return nothing(
      "no {model, thinking, max_tokens} triple appears on two or more slots — nothing to declare once",
    );
  }

  // Rank by blended price, cheapest first; unpriceable last in declaration order.
  const ranked = repeated
    .map((slots, order) => {
      const first = slots[0] as HoistSlot;
      return { slots, first, order, price: priceOf(first.model, pricing) };
    })
    .sort((a, b) => {
      const pa = a.price ?? Number.POSITIVE_INFINITY;
      const pb = b.price ?? Number.POSITIVE_INFINITY;
      return pa === pb ? a.order - b.order : pa - pb;
    });

  const existing = isRecord(spec["models"]) ? Object.keys(spec["models"]) : [];
  const taken = new Set<string>(existing);
  const names = rankNames(ranked.length);
  const profiles: HoistProfile[] = ranked.map((g, i) => ({
    name: freeName(names[i] as string, taken),
    model: g.first.model,
    ...(g.first.thinking !== undefined ? { thinking: g.first.thinking } : {}),
    ...(g.first.max_tokens !== undefined ? { max_tokens: g.first.max_tokens } : {}),
    ...(g.price !== undefined ? { pricePer1M: g.price } : {}),
    slots: g.slots,
  }));

  const edits: SpecEdit[] = [];
  const armRewrites: HoistArmRewrite[] = [];
  const seenRewrite = new Set<string>();
  for (const p of profiles) {
    edits.push({
      path: ["models", p.name],
      value: {
        model: p.model,
        ...(p.thinking !== undefined ? { thinking: p.thinking } : {}),
        ...(p.max_tokens !== undefined ? { max_tokens: p.max_tokens } : {}),
      },
      rationale: `upgrade --hoist-models: ${p.slots.length} slots declare this triple`,
    });
    for (const slot of p.slots) {
      edits.push({ path: [...slot.path, "model"], value: `$${p.name}` });
      if (slot.thinking !== undefined) edits.push({ path: [...slot.path, "thinking"] });
      if (slot.max_tokens !== undefined) edits.push({ path: [...slot.path, "max_tokens"] });
      if (slot.kind === "candidate" && !seenRewrite.has(slot.model)) {
        seenRewrite.add(slot.model);
        armRewrites.push({ model: slot.model, profile: p.name });
      }
    }
  }

  const { yaml } = applySpecEdits(yamlText, edits);
  return {
    action: "hoist",
    profiles,
    edits,
    yaml,
    diff: diffSpecYaml(yamlText, yaml),
    armRewrites,
  };
}

/** Render the plan for the terminal. `write` toggles the applied/dry-run wording. */
export function formatHoistPlan(plan: HoistPlan, write: boolean): string {
  if (plan.action === "nothing-to-hoist") {
    return `hoist-models: nothing to hoist — ${plan.reason ?? "no repeated triples"}.\n`;
  }
  const lines: string[] = [
    `hoist-models: ${plan.profiles.length} profile(s) lifted into models: (named by price rank, cheapest first)`,
  ];
  for (const p of plan.profiles) {
    const settings = [
      p.thinking !== undefined ? `thinking: ${JSON.stringify(p.thinking)}` : undefined,
      p.max_tokens !== undefined ? `max_tokens: ${p.max_tokens}` : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join(", ");
    const price = p.pricePer1M !== undefined ? ` · $${p.pricePer1M.toFixed(2)}/1M blended` : "";
    lines.push(`  $${p.name}: ${p.model}${settings === "" ? "" : ` (${settings})`}${price}`);
    for (const s of p.slots) lines.push(`      ← ${s.label}`);
  }
  for (const d of plan.diff) {
    if (d.kind === "added") lines.push(`  + ${d.path}: ${d.after}`);
    else if (d.kind === "removed") lines.push(`  - ${d.path}: ${d.before}`);
    else lines.push(`  ~ ${d.path}: ${d.before} → ${d.after}`);
  }
  lines.push("  the hoisted spec lowers to the same IR (profiles are a lower-time macro).");
  lines.push("");
  lines.push(
    write
      ? "  applied — spec rewritten in place."
      : "  dry-run — re-run with --write to apply (--write --rewrite-arms also re-keys learned history).",
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// arms.jsonl handling
// ---------------------------------------------------------------------------

export type ArmLineCounts = ReadonlyMap<string, number>;

/**
 * Count the `arms.jsonl` lines recorded under each of `models` (the `m`
 * field of both delta and aggregate lines). Absent file → every count 0.
 * Malformed lines are ignored, as the scoreboard reader ignores them.
 */
export function countArmLines(armsPath: string, models: ReadonlyArray<string>): ArmLineCounts {
  const counts = new Map<string, number>(models.map((m) => [m, 0]));
  if (!existsSync(armsPath)) return counts;
  for (const line of readFileSync(armsPath, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(rec) || typeof rec["m"] !== "string") continue;
    const m = rec["m"];
    if (counts.has(m)) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return counts;
}

/**
 * Re-key `arms.jsonl` lines from a candidate's model string to its new
 * profile name (`m` on delta and aggregate lines alike; the routeKey `k`
 * does not embed the model). Write-then-rename — the `compact()` pattern —
 * so a concurrent reader sees the old file or the new one, never a torn
 * one. Lines that do not parse are carried through verbatim. Returns the
 * line counts; a no-op when the file is absent.
 */
export function rewriteArmsFile(
  armsPath: string,
  rewrites: ReadonlyArray<HoistArmRewrite>,
): { readonly total: number; readonly rewritten: number } {
  if (!existsSync(armsPath) || rewrites.length === 0) return { total: 0, rewritten: 0 };
  const mapping = new Map(rewrites.map((r) => [r.model, r.profile]));
  const raw = readFileSync(armsPath, "utf-8");
  const lines = raw.split("\n");
  let total = 0;
  let rewritten = 0;
  const out = lines.map((line) => {
    if (line.trim() === "") return line;
    total += 1;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return line;
    }
    if (!isRecord(rec) || typeof rec["m"] !== "string") return line;
    const next = mapping.get(rec["m"]);
    if (next === undefined) return line;
    rewritten += 1;
    return JSON.stringify({ ...rec, m: next });
  });
  const tmp = `${armsPath}.tmp`;
  writeFileSync(tmp, out.join("\n"), { mode: 0o600 });
  renameSync(tmp, armsPath);
  return { total, rewritten };
}

/**
 * The "learned history" lines the CLI prints for a hoist that touches pool
 * candidates: what each rewrite does to the scoreboard and how to keep the
 * history (`--rewrite-arms`) or accept the reset. Empty when no candidate
 * was hoisted; an absent arms file still gets the one-line identity note.
 */
export function formatArmNotes(
  armsPath: string,
  plan: HoistPlan,
  outcome: { readonly rewritten?: number } = {},
): string {
  if (plan.armRewrites.length === 0) return "";
  const lines: string[] = ["  learned history (scoreboard arm identity):"];
  const counts = countArmLines(
    armsPath,
    plan.armRewrites.map((r) => r.model),
  );
  for (const r of plan.armRewrites) {
    const n = counts.get(r.model) ?? 0;
    lines.push(
      `    ${r.model} → $${r.profile}: arm id becomes the profile name${
        n > 0 ? ` (${n} line(s) in ${armsPath})` : ""
      }`,
    );
  }
  const any = [...counts.values()].some((n) => n > 0);
  if (outcome.rewritten !== undefined) {
    lines.push(`    re-keyed ${outcome.rewritten} arm line(s) in place (write-then-rename swap).`);
  } else if (any) {
    lines.push(
      "    NOTE: without --rewrite-arms those lines stay under the old id — a learned-history",
      "    reset for these arms (the pool re-learns them). Add --write --rewrite-arms to re-key.",
    );
  } else {
    lines.push("    no recorded arms under those ids — nothing to re-key.");
  }
  return `${lines.join("\n")}\n`;
}
