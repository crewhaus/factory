/**
 * The provability gate's closures (design §5.1–§5.4, §6), built from the
 * lowered `IrProvability`. runtime-core owns the gate — when it runs, the
 * retry/halt/note/escalate ladder, the trace and audit lines — and receives
 * everything that touches evidence, files, the network or a model as these
 * closures, so it stays dependency-free (the `opts.memory` /
 * `opts.continuity` posture).
 *
 *   - `verify(turn)` — `@crewhaus/provability`'s `verifyDocument` over the
 *     turn's final text, against the evidence index `gateEvidence` builds
 *     from the session log and the transcript (scoped by `config.scope`),
 *     the proof artifacts under the spec's proofs root, `checked` replay
 *     through the catalog (pure tools only, compared in the shape the log
 *     holds the call in, never a tool whose answer depends on the
 *     workspace — `./replay`), the guarded HEAD when `sources.resolve:
 *     head` (each URL screened by the run's egress fabric before it is sent,
 *     each request decided recorded as an `egress_decision` on the run's
 *     audit sink, when it has one), and the
 *     waiver judge when `provability.judge` is set — skipped, not guessed,
 *     once the run's `budget.judge_share` is spent. Every root is resolved
 *     per turn for the active tenant.
 *   - `renderBundle` — the one-line footer (`render: footer`) or the JSON
 *     (`render: json`); absent under `render: none`.
 *   - `displayPath` — the footer's path rule, for the run's live surfaces
 *     (the trace event a gateway client streams, a halt's detail).
 *   - `nudge` — provability's `renderNudge`: the model's own sentences, the
 *     evidence identifiers and fixed reasons, never fetched content.
 *   - `persist` — the bundle store under the proofs root, mode 0600.
 *   - `skill` — the rendered `provability` skill, which the runtime hands a
 *     Task child as read-only guidance (design §8, `./child-skill`); absent
 *     when this build ships none.
 *
 * `level`, `onFail`, `maxRetries`, `threshold`, `escalateTo` and `render`
 * are the IR's resolved values, verbatim.
 */
import { isAbsolute, relative, sep } from "node:path";
import type { CategoricalJudgeOptions } from "@crewhaus/eval-judge";
import type { IrProvability } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import {
  type EvidenceIndex,
  type ProofBundle,
  type VerifyOptions,
  createBundleStore,
  createFileArtifactStore,
  renderBundleJson,
  renderFooter,
  renderNudge,
  restrictToTurns,
  verifyDocument,
} from "@crewhaus/provability";
import type { ProvabilityTurn, RunProvability } from "@crewhaus/runtime-core";
import { proofRecheck, runtimeStateRoots, tenantRootOf } from "@crewhaus/tool-proof";
import { provabilitySkillText } from "./child-skill";
import { gateEvidenceScoped } from "./evidence";
import {
  type HeadDecision,
  type HeadResolver,
  RESOLVE_SINK_ID,
  SHARED_HEAD_CACHE,
  createHeadResolver,
} from "./head";
import { createWaiverJudge } from "./judge";
import { type GateCatalog, catalogReplay, schemaLookup } from "./replay";
import { activeTenant, fencedDir, gateProofsRoot, gateSessionRoot } from "./roots";

const logger = createLogger({ bindings: { module: "evaluation-service" } });

export type ProvabilityGateOptions = {
  readonly specName: string;
  /** Workspace root: path sources resolve inside it and `.crewhaus/proofs/` lives under it. */
  readonly cwd: string;
  /** Where `checked` replay finds the tools it re-runs. Absent ⇒ no replay (`replayed: false`). */
  readonly catalog?: GateCatalog;
  /** Where session logs live, when the run was given a root (else the runtime's default order). */
  readonly sessionRootDir?: string;
  /** Where the rendered bundle goes (`RunProvability.footerTarget`). */
  readonly footerTarget?: "stream" | "reply" | "none";
  /** The turn streams to its reader whatever `footerTarget` says (`RunProvability.streamed`). */
  readonly streamed?: boolean;
  /**
   * The HEAD request behind `sources.resolve: head` (default: tool-fetch's
   * `guardedHead`). `signal` aborts when the verifier's HEAD deadline
   * passes or the turn ends; a request that honours it stops then.
   */
  readonly resolveHead?: (url: string, signal?: AbortSignal) => Promise<number | undefined>;
  /**
   * How long one verification waits on its HEAD requests in all
   * (`VerifyOptions.headDeadlineMs`; default 15 s).
   */
  readonly headDeadlineMs?: number;
  /** Observe every bundle (the gateway envelope, the research report, tests). */
  readonly onBundle?: (bundle: ProofBundle, bundlePath?: string) => void;
  /** Test seam: the waiver judge's adapter. */
  readonly judgeAdapter?: CategoricalJudgeOptions["adapter"];
  readonly now?: () => Date;
  /**
   * The proofs root, when it is not the harness's (see
   * `WireEvaluationDeps.proofsRoot`): where `proof:` citations resolve and
   * bundles persist. Fenced to the active tenant like the default.
   */
  readonly proofsRoot?: string;
};

/**
 * A bundle path as the footer shows it: relative to `base` when it lies
 * inside it (`.crewhaus/proofs/<spec>/<session>/turn-7.json`), else as given.
 */
export function displayPath(path: string, base: string): string {
  const rel = relative(base, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : path;
}

/**
 * The text(s) `evidence` holds for a call of `toolName` with `input` — what a
 * replay is compared against. The verifier hands replay the `input` object
 * of the very record it is checking, so identity finds it; an equal input
 * logged by another call of the same tool counts too.
 */
function loggedResults(
  evidence: EvidenceIndex,
): (toolName: string, input: unknown) => ReadonlyArray<string> {
  return (toolName, input) => {
    let key: string | undefined;
    const keyOf = (): string | undefined => {
      try {
        key ??= JSON.stringify(input);
      } catch {
        // An input JSON cannot hold matches by identity only.
      }
      return key;
    };
    const found: string[] = [];
    for (const record of evidence.all()) {
      if (record.toolName !== toolName || record.isError) continue;
      let same = record.input === input;
      if (!same) {
        try {
          same = keyOf() !== undefined && JSON.stringify(record.input) === keyOf();
        } catch {
          same = false;
        }
      }
      if (same) found.push(record.content);
    }
    return found;
  };
}

/** One HEAD the verifier decided on, onto the run's audit sink as an `egress_decision`. */
function recordHead(
  sink: NonNullable<ProvabilityTurn["egressAuditSink"]>,
): (decision: HeadDecision) => Promise<void> {
  return async (decision) => {
    try {
      await sink.append({ kind: "egress_decision", payload: decision });
    } catch (err) {
      // As on every egress path: a full audit disk must not fail the answer.
      logger.warn("provability: the HEAD's egress_decision could not be recorded", {
        host: decision.host,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/** A signal that aborts when either does; `undefined` when neither is given. */
function eitherSignal(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return AbortSignal.any([a, b]);
}

/** The run's live judge-share read; a read that throws cannot say the share is spent. */
function shareSpent(turn: ProvabilityTurn): boolean {
  try {
    return turn.judgeShareExhausted?.() === true;
  } catch {
    return false;
  }
}

/**
 * The base a footer path is shown against: the tenant's own root inside a
 * tenant scope — the reply goes to that tenant's client, and the server's
 * directory layout above the tenant's root is none of its business — else
 * the workspace.
 */
function footerBase(cwd: string): string {
  const tenant = activeTenant();
  return tenant !== undefined ? tenantRootOf(tenant) : cwd;
}

/** The `RunProvability` for a lowered `provability:` block (see the module doc). */
export function buildRunProvability(
  config: IrProvability,
  opts: ProvabilityGateOptions,
): RunProvability {
  const { cwd, specName } = opts;
  const proofsRootOf = (tenant: ReturnType<typeof activeTenant>): string =>
    opts.proofsRoot !== undefined
      ? fencedDir(opts.proofsRoot, tenant)
      : gateProofsRoot(cwd, specName, tenant);
  const customHead = opts.resolveHead;
  // The default guarded HEAD shares one process-wide cache, so a session
  // asks once even where the gates are wired per turn (the channel bot).
  const head: HeadResolver | undefined =
    config.sources.resolve === "head"
      ? customHead !== undefined
        ? createHeadResolver(config.sources, (url, signal) => customHead(url, signal))
        : createHeadResolver(config.sources, undefined, SHARED_HEAD_CACHE)
      : undefined;

  const verify = async (turn: ProvabilityTurn): Promise<ProofBundle> => {
    const tenant = activeTenant();
    const proofs = proofsRootOf(tenant);
    const sessionRootDir = gateSessionRoot(opts.sessionRootDir, tenant);
    // Under `scope: turn` the index is the session's with the turn marked
    // (`turnNumbers`): grounding reads the turn, the self-written trace the
    // whole session (design §10).
    const { index: evidence, turnNumbers } = await gateEvidenceScoped({
      scope: config.scope,
      workspaceRoot: cwd,
      // A managed turn's runtime spills under the tenant's own root.
      ...(tenant !== undefined ? { toolResultsRoot: tenant.toolResultRoot } : {}),
      messages: turn.messages,
      ...(turn.isSynthetic !== undefined ? { isSynthetic: turn.isSynthetic } : {}),
      ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
      ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
      // An MCP call's origin is a field its schema declares: the run's own catalog's.
      inputSchemaOf: schemaLookup(opts.catalog),
      onUnreadable: (info) =>
        logger.warn("provability: a session log could not be read to its end", { ...info }),
    });
    const { replay, isPureTool } = catalogReplay(opts.catalog, {
      logged: loggedResults(
        turnNumbers !== undefined ? restrictToTurns(evidence, turnNumbers) : evidence,
      ),
      workspaceRoot: cwd,
      ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
    });
    const record =
      turn.egressAuditSink !== undefined ? recordHead(turn.egressAuditSink) : undefined;
    // Pillar 3 — the run's egress fabric screens every URL before its HEAD.
    const screenEgress = turn.screenEgress;
    const screen =
      screenEgress !== undefined ? (url: string) => screenEgress(url, RESOLVE_SINK_ID) : undefined;
    const verifyOptions: VerifyOptions = {
      config,
      evidence,
      ...(turnNumbers !== undefined ? { turnNumbers } : {}),
      workspaceRoot: cwd,
      artifacts: createFileArtifactStore({ rootDir: proofs }),
      // Where this run keeps its own record beyond the workspace's
      // `.crewhaus/`: a relocated session root, the proofs root, the
      // tenant's roots, the env relocations. A path under one is the model's
      // own text, never a source; the preflight reads the same list.
      stateRoots: runtimeStateRoots({
        workspaceRoot: cwd,
        proofsRoot: proofs,
        ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
        ...(tenant !== undefined ? { tenant } : {}),
      }),
      retryIndex: turn.retryIndex,
      ...(opts.headDeadlineMs !== undefined ? { headDeadlineMs: opts.headDeadlineMs } : {}),
      ...(opts.catalog !== undefined ? { replay, isPureTool } : {}),
      ...(head !== undefined
        ? {
            // The verifier's own signal ends a HEAD at its deadline (and
            // before the retry pass starts its own); the turn's ends it when
            // the turn does. Either one stops the request.
            resolveHead: (url: string, signal?: AbortSignal) => {
              const stop = eitherSignal(signal, turn.signal);
              return head(url, {
                ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
                ...(stop !== undefined ? { signal: stop } : {}),
                ...(record !== undefined ? { record } : {}),
                ...(screen !== undefined ? { screen } : {}),
              });
            },
          }
        : {}),
      // A stored builtin proof is checked again before it backs a claim
      // (design §6.4): the file is in the workspace, the checker is not.
      recheckProof: proofRecheck({
        timeoutMs: config.formal.timeoutMs,
        ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
      }),
      // Past the judge share the waiver is skipped, not guessed (§6.2): no
      // judge at all when the share is already spent, and the judge itself
      // re-reads it before every call, since its own spend can cross it.
      ...(config.judge !== undefined && !shareSpent(turn)
        ? {
            judgeWaiver: createWaiverJudge({
              judge: config.judge,
              bus: turn.bus,
              ...(opts.judgeAdapter !== undefined ? { adapter: opts.judgeAdapter } : {}),
              ...(turn.judgeShareExhausted !== undefined
                ? { exhausted: turn.judgeShareExhausted }
                : {}),
            }),
          }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    };
    return verifyDocument(turn.finalText, verifyOptions);
  };

  // §8 — rendered once per wiring: read-only guidance for Task children.
  const skill = provabilitySkillText(config);

  const renderBundle =
    config.render === "none"
      ? undefined
      : config.render === "json"
        ? (bundle: ProofBundle): string => renderBundleJson(bundle)
        : (bundle: ProofBundle, bundlePath?: string): string =>
            renderFooter(
              bundle,
              bundlePath !== undefined ? { path: displayPath(bundlePath, footerBase(cwd)) } : {},
            );

  return {
    level: config.level,
    onFail: config.onFail,
    displayPath: (bundlePath) => displayPath(bundlePath, footerBase(cwd)),
    maxRetries: config.maxRetries,
    threshold: config.threshold,
    ...(config.escalateTo !== undefined ? { escalateTo: config.escalateTo } : {}),
    render: config.render,
    ...(opts.footerTarget !== undefined ? { footerTarget: opts.footerTarget } : {}),
    ...(opts.streamed !== undefined ? { streamed: opts.streamed } : {}),
    verify,
    ...(renderBundle !== undefined ? { renderBundle } : {}),
    nudge: renderNudge,
    persist: async (bundle, at) =>
      createBundleStore({ rootDir: proofsRootOf(activeTenant()) }).put(bundle, at),
    ...(opts.onBundle !== undefined ? { onBundle: opts.onBundle } : {}),
    ...(skill !== undefined ? { skill } : {}),
  };
}
