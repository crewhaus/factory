/**
 * 0.8.0 (design/0.8.0-provability-release.md §9.1) — the eval runner's half of
 * the provability eval layer.
 *
 *   - THE GATE IN THE LOOP. A spec that declares `provability:` is measured
 *     as it serves: the default invoker wires the gate per sample through the
 *     same composition root every emitter and `crewhaus run` use
 *     (`@crewhaus/evaluation-service`'s `wireEvaluation`), so retries, nudges,
 *     the proof tools and the `provability` skill are the production ones.
 *     Only the `evaluation:` judge stays unwired here, exactly as before this
 *     release — a measurement run does not pay a second judge per sample.
 *   - THE STANDING BUNDLE PER SAMPLE. The gate calls `onBundle` once per pass;
 *     the last call is the standing verdict (the one the footer renders), and
 *     the invoker returns it as `AgentInvokeResult.proof`. `runSample` falls
 *     back to the bundle the last `provability_graded` event points at (a
 *     `halt` throws before the invoker can return; a hand-wired invoker may
 *     only persist) — only when the file's recomputed hash is the one the
 *     event graded — then writes it to `<sampleDir>/proof.json` and hands it
 *     to the graders as `RunResult.artifacts.proof`. A `halt` is the gate's
 *     terminal verdict: the run loop never spends its noise retry on it.
 *   - ISOLATION. The whole proofs root is the SAMPLE's own
 *     `.crewhaus/proofs/<spec>/` (the §7.2 per-sample fabric root): every
 *     pass's bundle persists there, `ProofCheck` files its artifacts there,
 *     and the gate resolves `proof:` citations there — never the harness's
 *     live proofs tree, so an eval run neither lands in `crewhaus provability
 *     audit` nor proves a claim with an artifact some production run (or an
 *     earlier sample) wrote. Evidence is read from the sample's own session
 *     log; path citations still resolve in the harness workspace (`cwd`).
 *     So a tool cassette (`--record-tools` / `--replay-tools`) carries each
 *     `ProofCheck` artifact with the call's result and a replay files it back
 *     under the replaying sample's root ({@link proofCassetteEffects}).
 *   - THE SAMPLE'S FLOOR. A sample's `metadata.provability.level`
 *     ({@link sampleGateIr}) re-floors THAT sample's gate, so its bundle is
 *     made at the floor it is graded at and every check that floor runs
 *     (replay at `checked`, …) really ran. Only on a gated run: the metadata
 *     never turns a gate on.
 *   - `--provability <level>` ({@link withProvabilityFloor}): measure a rung
 *     without editing the spec. The spec's block with its `level` replaced, or
 *     — when the spec declares none — the block the compiler lowers for the
 *     shorthand `provability: <level>` (every default resolved in one place,
 *     the compiler, never re-derived here). The six `provability.*` graders
 *     join the run ({@link provabilityGraderEntries}) as REQUIREMENTS beside
 *     the graders file's `combine:` policy, never inside it, and
 *     `costPerProvenClaim` as a report only.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type GateProofTools,
  mergeGateTools,
  observeProofBundles,
  proofsDirName,
  wireEvaluation,
} from "@crewhaus/evaluation-service";
import type { IrProvability, IrProvabilityLevel, IrV0 } from "@crewhaus/ir";
import {
  PROVABILITY_LEVELS,
  type ProofBundle,
  bundleHash,
  createFileArtifactStore,
  isProofArtifact,
  isProofId,
  isProvabilityLevel,
} from "@crewhaus/provability";
import type { RunProvability } from "@crewhaus/runtime-core";
import { parseSpec } from "@crewhaus/spec";
import type { RegisteredTool, ToolExecuteResult } from "@crewhaus/tool-catalog";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { RunnerError } from "./errors";
import { type ToolEffectsByName, canonicalJson } from "./tool-record";
import type { EvalPricingFn, GraderEntry } from "./types";

/** The standing bundle's file in a sample's artifact directory. */
export const PROOF_FILENAME = "proof.json";

/**
 * The block the compiler lowers for the shorthand `provability: <level>` on
 * a cli spec — the defaults `--provability` injects when the spec declares
 * none (execution.allow already expanded from the category grammar).
 */
export function defaultProvabilityBlock(level: IrProvabilityLevel): IrProvability {
  const ir = lower(
    parseSpec(
      [
        "name: eval-provability-floor",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: measure",
        `provability: ${level}`,
      ].join("\n"),
    ),
  ) as IrV0;
  if (ir.provability === undefined) {
    // Unreachable for a rung: only `off` lowers to nothing.
    throw new RunnerError(`provability: ${level} lowered to no gate`);
  }
  return ir.provability;
}

/**
 * The IR an eval measures under `--provability <level>`: the spec's block
 * with its floor replaced (every other knob — retries, on_fail, sources,
 * execution, render — kept as declared), or the shorthand's defaults when the
 * spec declares no block. `undefined` returns `ir` itself (same reference),
 * so an un-flagged run is untouched.
 */
export function withProvabilityFloor(ir: IrV0, level: string | undefined): IrV0 {
  if (level === undefined) return ir;
  if (!isProvabilityLevel(level)) {
    throw new RunnerError(
      `invalid provability ${JSON.stringify(level)} — must be one of ${PROVABILITY_LEVELS.join(", ")}`,
    );
  }
  const provability: IrProvability =
    ir.provability !== undefined ? { ...ir.provability, level } : defaultProvabilityBlock(level);
  return { ...ir, provability };
}

/**
 * The six `provability.*` graders to append to a run's grader set, skipping
 * any name the graders file already carries (an explicit entry — a registry
 * reference, a plugin override — wins, and joins the file's `combine:`
 * policy like every entry there). Each appended entry carries a
 * {@link GraderEntry.role}: the five with a bar are REQUIREMENTS (the sample
 * must pass each, on top of its own policy — a vacuous pass or a
 * lower-is-better rate can neither carry a `combine: any` nor skew a
 * `weighted` score), and `costPerProvenClaim` is a REPORT (always passing,
 * scored in dollars: it never votes). `pricing` (the run's
 * `RunEvalOptions.pricing`) prices the gate's re-runs on an unmetered run.
 * Lazily imported: an un-flagged run never loads the pack.
 */
export async function provabilityGraderEntries(
  existing: ReadonlyArray<{ readonly name: string }>,
  opts: { readonly pricing?: EvalPricingFn } = {},
): Promise<GraderEntry[]> {
  const { PROVABILITY_REPORTED_GRADERS, createProvabilityGraders } = await import(
    "@crewhaus/grader-provability"
  );
  const taken = new Set(existing.map((g) => g.name));
  const graders = createProvabilityGraders(
    opts.pricing !== undefined ? { pricing: opts.pricing } : {},
  );
  return graders
    .filter(([name]) => !taken.has(name))
    .map(([name, grader]) => ({
      name,
      grader,
      role: PROVABILITY_REPORTED_GRADERS.includes(name) ? "report" : "requirement",
    }));
}

/**
 * The IR one sample's gate runs under: on a GATED run, the sample's own
 * `metadata.provability.level` when it sets a valid one (the graders then
 * grade a bundle made at exactly that floor); otherwise `ir` itself (same
 * reference). An ungated run is never gated by metadata, and malformed
 * metadata leaves the run's floor (the graders fail that sample, naming the
 * field).
 */
export async function sampleGateIr(ir: IrV0, sample: Pick<Sample, "metadata">): Promise<IrV0> {
  if (ir.provability === undefined || sample.metadata?.["provability"] === undefined) return ir;
  const { sampleProvabilityOf } = await import("@crewhaus/grader-provability");
  const read = sampleProvabilityOf(sample);
  const level = read.ok ? read.value.level : undefined;
  return level === undefined || level === ir.provability.level
    ? ir
    : withProvabilityFloor(ir, level);
}

/** What the default invoker spreads into one sample's run, and how it reads the verdict back. */
export type SampleProvabilityWiring = GateProofTools & {
  readonly provability: RunProvability;
  /** The standing bundle: the last one the gate graded, once the turn is done. */
  readonly standing: () => ProofBundle | undefined;
  /**
   * What a tool cassette carries for this sample's proof tools
   * ({@link proofCassetteEffects} over the sample's own proofs root) — handed
   * to `recordingTools` / `replayingTools` beside the cassette.
   */
  readonly cassetteEffects: ToolEffectsByName;
};

/**
 * Wire the gate for ONE sample (see the module doc). `catalog` is where
 * `checked` replay finds the pure tools it re-runs — the sample's own tool
 * list, read at replay time. `undefined` when the IR carries no block.
 */
export async function wireSampleProvability(
  ir: Pick<IrV0, "name" | "agent" | "provability">,
  deps: {
    readonly cwd: string;
    readonly sessionRootDir: string;
    readonly catalog: { get(name: string): RegisteredTool | undefined };
  },
): Promise<SampleProvabilityWiring | undefined> {
  if (ir.provability === undefined) return undefined;
  let standing: ProofBundle | undefined;
  // Bundles, ProofCheck artifacts and `proof:` resolution: the sample's own tree.
  const proofsRoot = sampleProofsRoot(deps.sessionRootDir, ir.name);
  const gates = await wireEvaluation(
    { specName: ir.name, primaryModel: ir.agent.model, provability: ir.provability },
    {
      cwd: deps.cwd,
      sessionRootDir: deps.sessionRootDir,
      catalog: deps.catalog,
      // The answer is what the graders read: the footer streams after it
      // (into the sample's output) and never rides the returned text.
      footerTarget: "stream",
      proofsRoot,
    },
  );
  const observed = observeProofBundles(gates.provability, (bundle) => {
    standing = bundle;
  });
  if (observed === undefined) return undefined;
  return {
    tools: gates.tools,
    proofTools: gates.proofTools,
    provability: observed,
    standing: () => standing,
    cassetteEffects: proofCassetteEffects(proofsRoot),
  };
}

/** tool-proof's `ProofCheck`: the one proof tool that files an artifact. */
export const PROOF_CHECK_TOOL = "ProofCheck";

/**
 * NEW-HUNT-4 × design §9.1 — what a tool cassette carries for the gate's
 * `ProofCheck`. Its result NAMES a `prf_…` artifact it filed under the
 * sample's proofs root, and the gate resolves a `proof:` citation against
 * that FILE, not against the result. A cassette that held the result alone
 * replayed a run whose proofs were all met into one where every one failed
 * `proof_missing`: the replaying sample's root is its own, and empty.
 *
 * RECORD files the artifact the result names with the call's record (a
 * result that names none, or an artifact that is not there, is a call the
 * cassette cannot carry — see `ToolCallEffects.capture`). REPLAY puts it
 * back under THIS sample's root before the recorded result is returned.
 * `ProofCheck` itself still never runs on a replay — no checker, no
 * sandbox — so a cassette replays the same on a machine that has neither.
 *
 * The restore goes through the artifact store's own `put`: the id must be
 * a `prf_<16 hex>` and the record a well-formed artifact, so a cassette can
 * file one artifact under the sample's own root and nothing anywhere else.
 * A forged artifact proves a forged claim on replay exactly as a forged
 * WebFetch result grounds one: a cassette is evidence its owner vouches for
 * (`./tool-record`'s module doc). A replay that serves the same entry twice
 * (an exhausted key's last entry) finds it already filed and leaves it; a
 * DIFFERENT artifact under the same id is refused.
 */
export function proofCassetteEffects(proofsRoot: string): ToolEffectsByName {
  const store = createFileArtifactStore({ rootDir: proofsRoot });
  return new Map([
    [
      PROOF_CHECK_TOOL,
      {
        capture: async (result: ToolExecuteResult) => {
          const id = reportedProofId(result);
          if (id === undefined) {
            throw new RunnerError(
              `tool recording: the ${PROOF_CHECK_TOOL} result names no proof artifact, so the cassette cannot carry it`,
            );
          }
          const artifact = await store.get(id);
          if (artifact === undefined) {
            throw new RunnerError(
              `tool recording: ${PROOF_CHECK_TOOL} reported ${id}, but no such artifact is filed under ${store.rootDir}`,
            );
          }
          return artifact;
        },
        restore: async (effects: unknown) => {
          if (!isProofArtifact(effects)) {
            throw new RunnerError(`the recorded ${PROOF_CHECK_TOOL} artifact is malformed`);
          }
          const filed = await store.get(effects.id);
          if (filed !== undefined) {
            if (canonicalJson(filed) === canonicalJson(effects)) return;
            throw new RunnerError(
              `a different artifact is already filed as ${effects.id} under ${store.rootDir}`,
            );
          }
          await store.put(effects);
        },
      },
    ],
  ]);
}

/** The `id` of tool-proof's `checkReport` JSON, when `result` is one. */
function reportedProofId(result: ToolExecuteResult): string | undefined {
  if (typeof result !== "string") return undefined;
  try {
    const report: unknown = JSON.parse(result);
    const id =
      typeof report === "object" && report !== null
        ? (report as { readonly id?: unknown }).id
        : undefined;
    return isProofId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** A sample's own proofs root: `<sampleDir>/.crewhaus/proofs/<spec>/` (the gate's directory naming). */
export function sampleProofsRoot(sampleDir: string, specName: string): string {
  return join(sampleDir, ".crewhaus", "proofs", proofsDirName(specName));
}

/** `tools` with the sample's proof tools merged in (see `mergeGateTools`). */
export function withGateTools(
  tools: ReadonlyArray<RegisteredTool>,
  gate: GateProofTools,
): RegisteredTool[] {
  return gate.proofTools.length > 0 ? mergeGateTools(tools, gate) : [...tools];
}

/** Minimal shape check before a file read off disk is trusted as a bundle. */
function isBundleLike(value: unknown): value is ProofBundle {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Partial<Record<keyof ProofBundle, unknown>>;
  return (
    b.version === 1 &&
    (b.verdict === "pass" || b.verdict === "fail" || b.verdict === "unverified") &&
    isProvabilityLevel(b.level) &&
    typeof b.bundleHash === "string" &&
    typeof b.score === "number" &&
    Array.isArray(b.claims)
  );
}

/**
 * The standing bundle recorded by `events`: the file the LAST
 * `provability_graded` event points at (`bundlePath`), when it is there and
 * its content hashes to the `bundleHash` the event graded — recomputed over
 * the file (`@crewhaus/provability`'s `bundleHash`), never read off its own
 * `bundleHash` field, which an edit after persist would keep. `undefined`
 * when the run was not gated, the bundle was not persisted, or the file is
 * gone or does not match — a bundle that cannot be shown to be the graded
 * one is not used.
 */
export function standingBundleFromEvents(
  events: ReadonlyArray<TraceEvent>,
  cwd: string = process.cwd(),
): ProofBundle | undefined {
  let last: Extract<TraceEvent, { kind: "provability_graded" }> | undefined;
  for (const event of events) if (event.kind === "provability_graded") last = event;
  if (last?.bundlePath === undefined) return undefined;
  const path = isAbsolute(last.bundlePath) ? last.bundlePath : resolve(cwd, last.bundlePath);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isBundleLike(parsed) &&
      parsed.bundleHash === last.bundleHash &&
      bundleHash(parsed) === last.bundleHash
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
