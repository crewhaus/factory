/**
 * `wireEvaluation` — THE composition root for the in-loop gates (design §4.4).
 *
 * Every emitter (cli, channel, managed) renders one call to it and spreads
 * what it returns into `runChatLoop`; the `crewhaus run` / `serve`
 * interpreter calls it too. It builds:
 *
 *   - `evaluation` — the `evaluation:` judge (`./evaluation`), exactly the
 *     behaviour the three `renderEvaluation` copies and `buildRunEvaluation`
 *     had;
 *   - `provability` — the provability gate's closures (`./provability`);
 *   - `tools` / `proofTools` — the proof tools bound to the same
 *     configuration, proofs root and evidence as the gate (`./tools`): the
 *     ones the level adds, and all three (a same-named tool the run already
 *     has is replaced by its bound twin). The caller puts them on its run
 *     with `registerGateTools` (a catalog) or `mergeGateTools` (a list).
 *     Empty without a `provability:` block.
 *
 * The 0.6.0 rule now covers in-loop gates: a new gate lands here, never in an
 * emitter's codegen, and runtime-core receives closures, never a dependency.
 *
 * Nothing is opened at wiring time — no directory, no log, no sandbox, no
 * network: every root is resolved per turn (per call, for the tools) for the
 * tenant the turn runs under, so one wiring at a managed daemon's boot serves
 * every tenant. Any name the spec schema admits wires: the proofs directory
 * is `proofsDirName(specName)` (`./roots`), which maps a name provability's
 * store would refuse (a space, a `:`) instead of failing the bundle at boot.
 */
import { CrewhausError } from "@crewhaus/errors";
import type { CategoricalJudgeOptions } from "@crewhaus/eval-judge";
import type { IrProvability } from "@crewhaus/ir";
import type { SandboxLike } from "@crewhaus/proof-checker";
import { type EvidenceIndex, type ProofBundle, isProvabilityLevel } from "@crewhaus/provability";
import type { RunEvaluation, RunProvability } from "@crewhaus/runtime-core";
import type { ToolExecuteContext } from "@crewhaus/tool-catalog";
import { buildRunEvaluation } from "./evaluation";
import { gateEvidence } from "./evidence";
import type { EvaluationFragment } from "./fragment";
import { buildRunProvability } from "./provability";
import type { GateCatalog } from "./replay";
import { activeTenant, fencedDir, gateProofsRoot, gateSessionRoot } from "./roots";
import { type GateProofTools, gateTools } from "./tools";

export class EvaluationServiceError extends CrewhausError {
  override readonly name = "EvaluationServiceError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type WireEvaluationDeps = {
  /** The harness working directory: path sources resolve inside it, `.crewhaus/proofs/` lives under it. */
  readonly cwd: string;
  /**
   * Where `checked` replay finds the tools it re-runs: the bundle's
   * `defaultCatalog`, or the run's tool list. Read at replay time, so tools
   * registered after wiring are found. Absent ⇒ no replay.
   */
  readonly catalog?: GateCatalog;
  /**
   * The session-log root the RUN was given (`runChatLoop({ sessionRootDir })`),
   * when it was given one. Absent ⇒ the runtime's own order: the tenant's
   * `sessionRoot`, `CREWHAUS_SESSION_DIR`, `.crewhaus/sessions`.
   */
  readonly sessionRootDir?: string;
  /**
   * Where the proof footer goes: `"stream"` (cli — written after the answer)
   * or `"reply"` (channel bots and the managed gateway — appended to the text
   * they send). Absent ⇒ the runtime default, `"stream"`.
   */
  readonly footerTarget?: "stream" | "reply";
  /** A sandbox for the `smt` / `lean4` checkers; absent ⇒ chosen per run from what the run wires. */
  readonly sandbox?: SandboxLike;
  /** The HEAD request behind `sources.resolve: head` (default: tool-fetch's guarded HEAD). */
  readonly resolveHead?: (url: string) => Promise<number | undefined>;
  /** Observe every proof bundle (gateway envelopes, tests). */
  readonly onBundle?: (bundle: ProofBundle, bundlePath?: string) => void;
  /** Test seam: the adapter every judge call (evaluation and waiver) uses, bypassing the model-router. */
  readonly judgeAdapter?: CategoricalJudgeOptions["adapter"];
  /** Clock for bundles and artifacts (tests). */
  readonly now?: () => Date;
  /**
   * 0.8.0 §9.1 — the proofs root, when it must not be the harness's
   * `<cwd>/.crewhaus/proofs/<spec>/` (or the tenant's): where `ProofCheck`
   * files its artifacts, where the gate resolves `proof:` citations and where
   * bundles persist. The eval runner points it into each sample's own fabric
   * root (Pillar 2 isolation: a sample neither writes into nor cites from the
   * live proofs tree); `cwd` stays the workspace path citations resolve in.
   * Fenced to the active tenant's root like every other root. Absent ⇒ the
   * default, unchanged.
   */
  readonly proofsRoot?: string;
};

export type WiredGates = GateProofTools & {
  /** Present iff the fragment carries `evaluation`. */
  readonly evaluation?: RunEvaluation;
  /** Present iff the fragment carries `provability`. */
  readonly provability?: RunProvability;
};

const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

type BridgeLike = {
  readonly runContext?: { readonly sessionId?: unknown };
  readonly sessionRootDir?: unknown;
};

/** The run's session id, read the way tool-proof reads it: the context's, else the bridge's. */
function sessionIdOfCall(ctx: ToolExecuteContext | undefined): string | undefined {
  const bridge = ctx?.bridge as BridgeLike | undefined;
  const id = ctx?.runContext?.sessionId ?? bridge?.runContext?.sessionId;
  return typeof id === "string" && SESSION_ID_REGEX.test(id) ? id : undefined;
}

/** Where the runtime said its session logs live, when it said. */
function sessionRootOfCall(ctx: ToolExecuteContext | undefined): string | undefined {
  const bridge = ctx?.bridge as BridgeLike | undefined;
  const dir = typeof bridge === "object" && bridge !== null ? bridge.sessionRootDir : undefined;
  return typeof dir === "string" && dir !== "" ? dir : undefined;
}

/** A malformed fragment is a build or a hand-edit gone wrong: refuse it at boot, by name. */
function assertProvability(config: IrProvability): void {
  if (typeof config !== "object" || config === null || !isProvabilityLevel(config.level)) {
    throw new EvaluationServiceError(
      `evaluation-service: fragment.provability.level must be one of cited, grounded, checked, proven (got ${JSON.stringify(
        (config as { level?: unknown } | null)?.level,
      )})`,
    );
  }
}

/** Build the gates a fragment declares (see the module doc). */
export async function wireEvaluation(
  fragment: EvaluationFragment,
  deps: WireEvaluationDeps,
): Promise<WiredGates> {
  if (typeof fragment !== "object" || fragment === null) {
    throw new EvaluationServiceError("evaluation-service: wireEvaluation needs a fragment");
  }
  const evaluation =
    fragment.evaluation !== undefined
      ? buildRunEvaluation(fragment.evaluation, fragment.primaryModel, {
          ...(deps.judgeAdapter !== undefined ? { judgeAdapter: deps.judgeAdapter } : {}),
        })
      : undefined;
  const config = fragment.provability;
  if (config === undefined) {
    return { ...(evaluation !== undefined ? { evaluation } : {}), tools: [], proofTools: [] };
  }
  assertProvability(config);
  const { cwd } = deps;
  const specName = fragment.specName;
  if (typeof specName !== "string") {
    throw new EvaluationServiceError("evaluation-service: fragment.specName must be a string");
  }

  const provability = buildRunProvability(config, {
    specName,
    cwd,
    ...(deps.catalog !== undefined ? { catalog: deps.catalog } : {}),
    ...(deps.sessionRootDir !== undefined ? { sessionRootDir: deps.sessionRootDir } : {}),
    ...(deps.footerTarget !== undefined ? { footerTarget: deps.footerTarget } : {}),
    ...(deps.resolveHead !== undefined ? { resolveHead: deps.resolveHead } : {}),
    ...(deps.onBundle !== undefined ? { onBundle: deps.onBundle } : {}),
    ...(deps.judgeAdapter !== undefined ? { judgeAdapter: deps.judgeAdapter } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.proofsRoot !== undefined ? { proofsRoot: deps.proofsRoot } : {}),
  });

  // The preflight's evidence: the gate's own builder over the run's log
  // (the transcript is not reachable from a tool call, and the log already
  // holds every call the turn has finished), scoped the same way.
  const evidence = async (ctx: ToolExecuteContext | undefined): Promise<EvidenceIndex> => {
    const tenant = activeTenant();
    const callRoot = sessionRootOfCall(ctx);
    const sessionRootDir =
      deps.sessionRootDir === undefined && callRoot !== undefined
        ? fencedDir(callRoot, tenant)
        : gateSessionRoot(deps.sessionRootDir, tenant);
    const sessionId = sessionIdOfCall(ctx);
    return gateEvidence({
      scope: config.scope,
      workspaceRoot: cwd,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
    });
  };

  const proofTools = gateTools({
    config,
    workspaceRoot: cwd,
    proofsRoot: (tenant) =>
      deps.proofsRoot !== undefined
        ? fencedDir(deps.proofsRoot, tenant)
        : gateProofsRoot(cwd, specName, tenant),
    evidence,
    ...(deps.sandbox !== undefined ? { sandbox: deps.sandbox } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  return {
    ...(evaluation !== undefined ? { evaluation } : {}),
    provability,
    ...proofTools,
  };
}
