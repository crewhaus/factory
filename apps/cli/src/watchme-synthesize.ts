/**
 * "Watch me" §7 (design/watch-me.md) — `crewhaus watchme synthesize`: draft a
 * NEW agent-loop spec that mimics observed usage. The deterministic path
 * starts from the `crewhaus init` cli template and drives `applySpecEdits`
 * (the AUTHOR surface — deliberately not `restrictToOptimizable`; the
 * synthesized file is a brand-new proposal, not a mutation of a live spec)
 * with ONE SpecEdit per learned fact, each carrying a rationale string tying
 * the edit back to observed evidence ("observed intent X across N sessions").
 *
 * Learned facts: distilled instructions from the top intent clusters
 * (redacted via the injected callback), `tools`/`mcp_servers` from the
 * observed tool vocabulary, an `agent.model_pool` ordered cheapest→strongest
 * from observed + counterfactual-viable models (`policy: learned` — the
 * candidate set stays human-approved, selection self-tunes at runtime),
 * `evaluation:`/`feedback:` from the observed quality bar, `memory`/
 * `continuity` when re-ask signals were observed, and a `watchme:` block so
 * the synthesized agent keeps the observation loop that produced it.
 *
 * Gate (never write an invalid spec): `parseSpecIssues` empty AND `compile()`
 * green AND the spec `safeName` charset on the name. Output is ALWAYS a new
 * file under `.crewhaus/watchme/synthesized/` — `force` is required to
 * overwrite, and existing specs are never touched.
 *
 * Everything here is pure + deterministic (feedback.ts / fewshot.ts mold):
 * filesystem access goes through the injected {@link SynthesizeFs} seam, the
 * `--interactive` interview is an injected `runConversationalInterview`-shaped
 * callback seeded with the observation digest, and `--propose` hands off via
 * an injected `assembleProposal`-shaped callback with source `"watchme"`. The
 * CLI entry file wires the real seams.
 */
import { dirname, join } from "node:path";
import { compile } from "@crewhaus/compiler";
import { type Spec, parseSpec, parseSpecIssues } from "@crewhaus/spec";
import {
  type SpecDiffEntry,
  type SpecEdit,
  applySpecEdits,
  diffSpecYaml,
} from "@crewhaus/spec-patch";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import type { WatchmeObservation } from "@crewhaus/watchme-store";
import type { IntentDigest } from "./intents";

/** Thrown on an unsafe name, a gate failure, or an overwrite refusal. The CLI
 *  routes the message through `die()`; tests assert on `.message`. */
export class WatchmeSynthesizeError extends Error {
  override readonly name = "WatchmeSynthesizeError";
}

/** The spec `safeName` charset (packages/spec) — checked UP FRONT so an unsafe
 *  `--name` fails with one clear message (and never reaches the output path
 *  join) instead of surfacing as a zod issue dump at the parse gate. */
const SAFE_NAME_RE = /^[\w .:-]+$/;

function assertSafeName(name: string): void {
  if (SAFE_NAME_RE.test(name)) return;
  throw new WatchmeSynthesizeError(
    `"${name}" is not a safe spec name — use only letters, digits, spaces, and '_ . - :' (no newlines, quotes, slashes, or comment/template delimiters)`,
  );
}

/**
 * The `crewhaus init` cli template (`runInit` in index.ts), reproduced
 * verbatim — the deterministic path starts from the exact baseline a fresh
 * harness gets, then layers one SpecEdit per learned fact on top. Keep in
 * sync with `runInit`'s inline `yamlText`.
 */
export function cliTemplateYaml(specName: string): string {
  return `name: ${specName}
target: cli
agent:
  model: claude-opus-5
  instructions: |
    You are a helpful assistant. Replace these instructions with your
    agent's actual behavior, persona, and constraints.
`;
}

/** A counterfactual-viable candidate from the report's cheaper-model analysis
 *  (§7 phase 1 step 5): a model the harness never ran whose capability + cost
 *  profile fits the observed workload. */
export type CounterfactualCandidate = {
  /** Model string in the router grammar (the spec surface). */
  readonly model: string;
  /** Projected cost per assistant turn in micro-USD; undefined = unpriced
   *  (UNKNOWN, never free — such candidates order last, not first). */
  readonly estCostUsdMicrosPerTurn?: number;
};

export type WatchmeSynthesisInput = {
  /** Proposed spec name — becomes the `name:` field and the output filename. */
  readonly name: string;
  /** The watched harness's observation digests (`watchme/observations.jsonl`). */
  readonly observations: ReadonlyArray<WatchmeObservation>;
  /** Clustered intents over the watched sessions (`clusterIntents` output). */
  readonly intents: IntentDigest;
  readonly counterfactualModels?: ReadonlyArray<CounterfactualCandidate>;
  /** Spec-grammar `mcp_servers` configs copied from the WATCHED spec, keyed by
   *  server name. Only servers the observations actually exercised are copied
   *  into the synthesized spec; observed servers with no config are skipped
   *  (a fabricated `command` would be dishonest vaporware). */
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  /** Sync redactor applied to every observed text fragment (intent
   *  representatives) before it enters the spec, digest, or rationales — the
   *  `redactDigest` mold; the CLI backs it with its PII-redactor cache. */
  readonly redact: (text: string) => string;
};

// ---------------------------------------------------------------------------
// observed-usage aggregation (pure helpers)
// ---------------------------------------------------------------------------

type ModelUsage = {
  readonly model: string;
  readonly turns: number;
  readonly sessions: number;
  /** Mean cost per turn over PRICED turns, micro-USD; undefined = unknown. */
  readonly meanCostUsdMicrosPerTurn?: number;
};

function aggregateModelUsage(
  observations: ReadonlyArray<WatchmeObservation>,
): ReadonlyArray<ModelUsage> {
  const acc = new Map<
    string,
    { turns: number; sessions: number; pricedTurns: number; pricedCost: number }
  >();
  for (const obs of observations) {
    const seen = new Set<string>();
    for (const row of obs.models) {
      const model = row.spec ?? row.wire;
      const entry = acc.get(model) ?? { turns: 0, sessions: 0, pricedTurns: 0, pricedCost: 0 };
      entry.turns += row.turns;
      if (!seen.has(model)) {
        entry.sessions += 1;
        seen.add(model);
      }
      if (row.costUsdMicros !== undefined && row.unpriced !== true && row.turns > 0) {
        entry.pricedTurns += row.turns;
        entry.pricedCost += row.costUsdMicros;
      }
      acc.set(model, entry);
    }
  }
  return [...acc.entries()]
    .map(([model, e]) => ({
      model,
      turns: e.turns,
      sessions: e.sessions,
      ...(e.pricedTurns > 0 ? { meanCostUsdMicrosPerTurn: e.pricedCost / e.pricedTurns } : {}),
    }))
    .sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
}

const MCP_TOOL_RE = /^mcp__(.+?)__.+$/;

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

type ToolVocabulary = {
  /** Spec `tools:` keys (BUILTIN_TOOL_MAP members) → observed call count. */
  readonly builtins: ReadonlyArray<readonly [string, number]>;
  /** MCP server name → observed call count. */
  readonly mcpServers: ReadonlyArray<readonly [string, number]>;
};

/** Partition the observed tool vocabulary: registered builtin names map to
 *  their camelCase spec keys (membership-gated by `BUILTIN_TOOL_MAP`, so the
 *  emitted `tools:` list always resolves at codegen); `mcp__<server>__<tool>`
 *  names collapse to their server; everything else (continuity/memory/wiki
 *  tools, which come from their own blocks) is dropped. */
function observedToolVocabulary(observations: ReadonlyArray<WatchmeObservation>): ToolVocabulary {
  const builtins = new Map<string, number>();
  const mcp = new Map<string, number>();
  for (const obs of observations) {
    for (const t of obs.toolStats) {
      const m = MCP_TOOL_RE.exec(t.name);
      if (m !== null && m[1] !== undefined) {
        mcp.set(m[1], (mcp.get(m[1]) ?? 0) + t.calls);
        continue;
      }
      const key = lowerFirst(t.name);
      if (Object.hasOwn(BUILTIN_TOOL_MAP, key)) {
        builtins.set(key, (builtins.get(key) ?? 0) + t.calls);
      }
    }
  }
  const byCallsThenName = (a: readonly [string, number], b: readonly [string, number]): number =>
    b[1] - a[1] || a[0].localeCompare(b[0]);
  return {
    builtins: [...builtins.entries()].sort(byCallsThenName),
    mcpServers: [...mcp.entries()].sort(byCallsThenName),
  };
}

/** Pooled quality bar over the observations: rating and judge means weighted
 *  by their counts. `undefined` when nothing was ever rated or judged. */
function observedQualityBar(
  observations: ReadonlyArray<WatchmeObservation>,
): { readonly bar: number; readonly n: number } | undefined {
  let n = 0;
  let sum = 0;
  for (const obs of observations) {
    const q = obs.quality;
    if (q === undefined) continue;
    if (q.meanRating !== undefined && q.ratings > 0) {
      n += q.ratings;
      sum += q.meanRating * q.ratings;
    }
    if (q.meanJudge !== undefined && q.judged > 0) {
      n += q.judged;
      sum += q.meanJudge * q.judged;
    }
  }
  return n > 0 ? { bar: sum / n, n } : undefined;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// learned facts → SpecEdits
// ---------------------------------------------------------------------------

/**
 * Derive the learned-fact edit batch from the observed evidence — one
 * `SpecEdit` per fact, every edit carrying a rationale that names the
 * observed evidence behind it. Pure and deterministic; facts without
 * supporting evidence are simply absent (the template baseline stands).
 */
export function buildSynthesisEdits(input: WatchmeSynthesisInput): ReadonlyArray<SpecEdit> {
  const edits: SpecEdit[] = [];
  const sessions =
    input.observations.length > 0 ? input.observations.length : input.intents.totalSessions;

  // -- distilled instructions from the top intents (redacted) ---------------
  const top = input.intents.topIntents;
  const topIntent = top[0];
  if (topIntent !== undefined) {
    const lines: string[] = [
      `You are ${input.name}, an assistant synthesized from ${sessions} observed sessions of`,
      `real usage ("watch me"). Serve the recurring requests below well.`,
      "",
      "The most common requests, in observed order of demand:",
    ];
    for (const i of top) {
      lines.push(
        `- "${input.redact(i.representative)}" (${i.occurrences} asks across ${i.sessionCount} sessions)`,
      );
    }
    if (input.intents.lowSatisfactionIntents.length > 0) {
      lines.push("", "Requests that previously scored poorly — handle these with extra care:");
      for (const i of input.intents.lowSatisfactionIntents) {
        lines.push(`- "${input.redact(i.representative)}"`);
      }
    }
    edits.push({
      path: ["agent", "instructions"],
      value: `${lines.join("\n")}\n`,
      rationale:
        `observed intent "${input.redact(topIntent.representative)}" across ` +
        `${topIntent.sessionCount} sessions — distilled ${top.length} recurring intents ` +
        `from ${input.intents.totalTurns} user turns`,
    });
  }

  // -- observed primary model + the cheapest→strongest model_pool -----------
  const usage = aggregateModelUsage(input.observations);
  const primary = usage[0];
  if (primary !== undefined) {
    const totalTurns = usage.reduce((n, m) => n + m.turns, 0);
    edits.push({
      path: ["agent", "model"],
      value: primary.model,
      rationale:
        `observed ${primary.turns}/${totalTurns} assistant turns on ${primary.model} ` +
        `across ${sessions} sessions`,
    });
  }
  const poolNames = new Set(usage.map((m) => m.model));
  const poolRows: Array<{ readonly model: string; readonly cost?: number }> = usage.map((m) => ({
    model: m.model,
    ...(m.meanCostUsdMicrosPerTurn !== undefined ? { cost: m.meanCostUsdMicrosPerTurn } : {}),
  }));
  for (const c of input.counterfactualModels ?? []) {
    if (poolNames.has(c.model)) continue;
    poolNames.add(c.model);
    poolRows.push({
      model: c.model,
      ...(c.estCostUsdMicrosPerTurn !== undefined ? { cost: c.estCostUsdMicrosPerTurn } : {}),
    });
  }
  if (poolRows.length >= 2) {
    // Cheapest→strongest: priced candidates ascending by cost per turn;
    // unpriced cost is UNKNOWN (never free), so those order last, by name.
    const priced = poolRows.filter((r) => r.cost !== undefined);
    const unpriced = poolRows.filter((r) => r.cost === undefined);
    priced.sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0) || a.model.localeCompare(b.model));
    unpriced.sort((a, b) => a.model.localeCompare(b.model));
    const ordered = [...priced, ...unpriced].map((r) => r.model);
    const observedCount = usage.length;
    edits.push({
      path: ["agent", "model_pool"],
      value: { candidates: ordered.map((model) => ({ model })), policy: "learned" },
      rationale: `ordered cheapest→strongest from ${observedCount} observed + ${ordered.length - observedCount} counterfactual-viable models across ${sessions} sessions; policy: learned self-tunes selection within the human-approved set`,
    });
  }

  // -- tools / mcp_servers from the observed tool vocabulary ----------------
  const vocab = observedToolVocabulary(input.observations);
  if (vocab.builtins.length > 0) {
    edits.push({
      path: ["tools"],
      value: vocab.builtins.map(([name]) => name),
      rationale: `observed tool usage across ${sessions} sessions: ${vocab.builtins.map(([name, calls]) => `${name}×${calls}`).join(", ")}`,
    });
  }
  for (const [server, calls] of vocab.mcpServers) {
    const config = input.mcpServers?.[server];
    if (config === undefined) continue;
    edits.push({
      path: ["mcp_servers", server],
      value: config,
      rationale: `observed ${calls} calls to MCP server "${server}" across ${sessions} sessions (config copied from the watched spec)`,
    });
  }

  // -- evaluation/feedback from the observed quality bar --------------------
  const quality = observedQualityBar(input.observations);
  if (quality !== undefined) {
    const threshold = clamp(Math.round(quality.bar * 100) / 100, 0.5, 0.95);
    const criteria =
      topIntent !== undefined
        ? `Answer correctly, completely, and concisely — especially recurring requests like ${top
            .slice(0, 3)
            .map((i) => `"${input.redact(i.representative)}"`)
            .join("; ")}.`
        : "Answer the user's request correctly, completely, and concisely.";
    edits.push({
      path: ["evaluation"],
      value: { grader: { type: "llm_judge", criteria }, threshold },
      rationale:
        `observed quality bar ${quality.bar.toFixed(2)} over ${quality.n} rated/judged ` +
        `turns across ${sessions} sessions`,
    });
  }
  let up = 0;
  let down = 0;
  let ratings = 0;
  for (const obs of input.observations) {
    up += obs.feedback?.up ?? 0;
    down += obs.feedback?.down ?? 0;
    ratings += obs.quality?.ratings ?? 0;
  }
  if (up + down + ratings > 0) {
    edits.push({
      path: ["feedback"],
      value: { enabled: true },
      rationale: `observed ${up} up / ${down} down human ratings across ${sessions} sessions — keep collecting the signal behind the quality bar`,
    });
  }

  // -- memory/continuity when re-ask signals were observed ------------------
  const reasked = input.intents.intents
    .filter((i) => i.sessionCount >= 2)
    .sort((a, b) => b.sessionCount - a.sessionCount || b.occurrences - a.occurrences);
  const topReask = reasked[0];
  if (topReask !== undefined) {
    edits.push({
      path: ["memory"],
      value: { enabled: true },
      rationale:
        `observed intent "${input.redact(topReask.representative)}" re-asked across ` +
        `${topReask.sessionCount} sessions — memory retains the answer between sessions`,
    });
    edits.push({
      path: ["continuity"],
      value: true,
      rationale: `re-ask signals observed across ${reasked.length} intent clusters — continuity carries focus/plans/ledger between sessions`,
    });
  }

  // -- watchme: the synthesized agent keeps the loop that produced it -------
  edits.push({
    path: ["watchme"],
    value: { enabled: true },
    rationale:
      "observed-from-birth: the synthesized agent keeps running the observation loop " +
      "that produced this spec",
  });

  return edits;
}

// ---------------------------------------------------------------------------
// gate + deterministic synthesis
// ---------------------------------------------------------------------------

/** The §7 gate — `parseSpecIssues` empty AND `compile()` green. Returns the
 *  parsed Spec; throws {@link WatchmeSynthesizeError} on any diagnostic so an
 *  invalid spec is never written. */
export function gateSpecYaml(yaml: string): Spec {
  const issues = parseSpecIssues(yaml);
  if (issues.length > 0) {
    const rendered = issues
      .slice(0, 5)
      .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new WatchmeSynthesizeError(`synthesized spec failed validation: ${rendered}`);
  }
  try {
    compile(yaml);
  } catch (err) {
    throw new WatchmeSynthesizeError(
      `synthesized spec failed to compile: ${(err as Error).message}`,
    );
  }
  return parseSpec(yaml);
}

export type SynthesizedSpec = {
  readonly yaml: string;
  readonly spec: Spec;
  readonly edits: ReadonlyArray<SpecEdit>;
  /** Structural diff vs {@link cliTemplateYaml} (credential-redacted). */
  readonly diff: ReadonlyArray<SpecDiffEntry>;
  /** The template baseline the edits were applied to — the `currentYaml` side
   *  of the `--propose` handoff, so the proposal diff IS the learned facts. */
  readonly baseYaml: string;
};

/** The deterministic path: init template → learned-fact edits → gate. Pure. */
export function synthesizeSpec(input: WatchmeSynthesisInput): SynthesizedSpec {
  assertSafeName(input.name);
  const baseYaml = cliTemplateYaml(input.name);
  const edits = buildSynthesisEdits(input);
  let yaml: string;
  try {
    yaml = applySpecEdits(baseYaml, edits).yaml;
  } catch (err) {
    throw new WatchmeSynthesizeError(
      `synthesis produced an invalid spec: ${(err as Error).message}`,
    );
  }
  const spec = gateSpecYaml(yaml);
  return { yaml, spec, edits, diff: diffSpecYaml(baseYaml, yaml), baseYaml };
}

// ---------------------------------------------------------------------------
// observation digest (the --interactive interview seed)
// ---------------------------------------------------------------------------

/** Render the observed evidence as a compact text digest — the seed the
 *  `--interactive` interview callback receives. Every text fragment passes
 *  through the injected redactor. */
export function renderObservationDigest(input: WatchmeSynthesisInput): string {
  const sessions =
    input.observations.length > 0 ? input.observations.length : input.intents.totalSessions;
  const lines: string[] = [
    `watch-me observation digest — ${input.name}`,
    `sessions observed: ${sessions}; user turns: ${input.intents.totalTurns}; ` +
      `intent clusters: ${input.intents.intents.length}`,
  ];
  if (input.intents.topIntents.length > 0) {
    lines.push("top intents:");
    for (const i of input.intents.topIntents) {
      lines.push(
        `  - "${input.redact(i.representative)}" — ${i.occurrences} asks across ` +
          `${i.sessionCount} sessions`,
      );
    }
  }
  const usage = aggregateModelUsage(input.observations);
  if (usage.length > 0) {
    lines.push("models:");
    for (const m of usage) {
      const cost =
        m.meanCostUsdMicrosPerTurn !== undefined
          ? `, ~$${(m.meanCostUsdMicrosPerTurn / 1_000_000).toFixed(4)}/turn`
          : " (unpriced)";
      lines.push(`  - ${m.model}: ${m.turns} turns${cost}`);
    }
  }
  const vocab = observedToolVocabulary(input.observations);
  if (vocab.builtins.length > 0) {
    lines.push(`tools: ${vocab.builtins.map(([name, calls]) => `${name}×${calls}`).join(", ")}`);
  }
  if (vocab.mcpServers.length > 0) {
    lines.push(
      `mcp servers: ${vocab.mcpServers.map(([name, calls]) => `${name}×${calls}`).join(", ")}`,
    );
  }
  const quality = observedQualityBar(input.observations);
  lines.push(
    quality !== undefined
      ? `quality bar: ${quality.bar.toFixed(2)} over ${quality.n} rated/judged turns`
      : "quality bar: no rated/judged turns observed",
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// summary rendering
// ---------------------------------------------------------------------------

const DIFF_MARK: Record<SpecDiffEntry["kind"], string> = {
  added: "+",
  removed: "-",
  changed: "~",
};

/** Render the printed summary: the per-edit rationales (the learned facts)
 *  plus the `diffSpecYaml` entries vs the init template. */
export function renderSynthesisSummary(opts: {
  readonly outPath: string;
  readonly edits: ReadonlyArray<SpecEdit>;
  readonly diff: ReadonlyArray<SpecDiffEntry>;
}): string {
  const lines: string[] = [`synthesized ${opts.outPath}`];
  if (opts.edits.length > 0) {
    lines.push("learned facts:");
    for (const e of opts.edits) {
      lines.push(`  - ${e.path.map(String).join(".")} — ${e.rationale ?? "(no rationale)"}`);
    }
  }
  if (opts.diff.length > 0) {
    lines.push("diff vs the init template:");
    for (const d of opts.diff) {
      const change =
        d.kind === "changed" ? `${d.before} → ${d.after}` : d.kind === "added" ? d.after : d.before;
      lines.push(`  ${DIFF_MARK[d.kind]} ${d.path}: ${change}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// orchestration (injected fs / interview / propose seams)
// ---------------------------------------------------------------------------

/** Filesystem seam — the CLI wires node:fs; tests inject a map. */
export type SynthesizeFs = {
  exists(path: string): boolean;
  /** Recursive directory create (mkdir -p). */
  mkdirp(dir: string): void;
  write(path: string, text: string): void;
};

/** The `--interactive` seam: a `runConversationalInterview`-shaped callback,
 *  seeded with the observation digest. The returned YAML goes through the
 *  SAME gate as the deterministic path before anything is written. */
export type SynthesizeInterview = (opts: {
  readonly specName: string;
  /** `renderObservationDigest` output — what the interviewer knows going in. */
  readonly seedDigest: string;
}) => Promise<{ readonly yaml: string }>;

/** The `--propose` seam: an `assembleProposal`-shaped handoff (propose.ts).
 *  `currentYaml` is the init-template baseline, so the proposal diff shows
 *  exactly the learned facts; `source` is always `"watchme"`. */
export type SynthesizePropose = (opts: {
  readonly specName: string;
  readonly currentYaml: string;
  readonly proposedYaml: string;
  readonly source: "watchme";
}) => Promise<void> | void;

export type RunSynthesizeOptions = {
  /** Harness root (the standalone-harness cwd): the default output path is
   *  `<rootDir>/.crewhaus/watchme/synthesized/<name>.yaml`. */
  readonly rootDir: string;
  readonly fs: SynthesizeFs;
  /** `--out` override (CLI-resolved). */
  readonly outFile?: string;
  /** `--force`: required to overwrite an existing output file. */
  readonly force?: boolean;
  readonly interview?: SynthesizeInterview;
  readonly propose?: SynthesizePropose;
};

export type RunSynthesizeResult = {
  readonly outPath: string;
  readonly yaml: string;
  readonly spec: Spec;
  /** Empty in interactive mode — the interview produced the YAML wholesale. */
  readonly edits: ReadonlyArray<SpecEdit>;
  readonly diff: ReadonlyArray<SpecDiffEntry>;
  readonly summary: string;
};

/**
 * `crewhaus watchme synthesize` — the whole verb behind the CLI handler:
 * synthesize (deterministic or interactive), gate, refuse-overwrite, write
 * the NEW file, optionally hand off to propose. Existing specs are never
 * touched; the overwrite check runs FIRST so a whole interview is never
 * spent on an un-writable output.
 */
export async function runWatchmeSynthesize(
  input: WatchmeSynthesisInput,
  opts: RunSynthesizeOptions,
): Promise<RunSynthesizeResult> {
  assertSafeName(input.name);
  const outPath =
    opts.outFile ?? join(opts.rootDir, ".crewhaus", "watchme", "synthesized", `${input.name}.yaml`);
  if (opts.fs.exists(outPath) && opts.force !== true) {
    throw new WatchmeSynthesizeError(
      `refusing to overwrite ${outPath} — pass --force to replace it`,
    );
  }

  const baseYaml = cliTemplateYaml(input.name);
  let yaml: string;
  let spec: Spec;
  let edits: ReadonlyArray<SpecEdit>;
  if (opts.interview !== undefined) {
    const res = await opts.interview({
      specName: input.name,
      seedDigest: renderObservationDigest(input),
    });
    yaml = res.yaml;
    spec = gateSpecYaml(yaml);
    edits = [];
  } else {
    const s = synthesizeSpec(input);
    yaml = s.yaml;
    spec = s.spec;
    edits = s.edits;
  }
  const diff = diffSpecYaml(baseYaml, yaml);

  opts.fs.mkdirp(dirname(outPath));
  opts.fs.write(outPath, yaml);

  if (opts.propose !== undefined) {
    await opts.propose({
      specName: input.name,
      currentYaml: baseYaml,
      proposedYaml: yaml,
      source: "watchme",
    });
  }

  return {
    outPath,
    yaml,
    spec,
    edits,
    diff,
    summary: renderSynthesisSummary({ outPath, edits, diff }),
  };
}
