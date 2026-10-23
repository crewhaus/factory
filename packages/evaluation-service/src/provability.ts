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
 *     holds the call in — `./replay`), the guarded HEAD when
 *     `sources.resolve: head` (each request decided is recorded as an
 *     `egress_decision` on the run's audit sink, when it has one), and the
 *     waiver judge when `provability.judge` is set — skipped, not guessed,
 *     once the run's `budget.judge_share` is spent. Every root is resolved
 *     per turn for the active tenant.
 *   - `renderBundle` — the one-line footer (`render: footer`) or the JSON
 *     (`render: json`); absent under `render: none`.
 *   - `nudge` — provability's `renderNudge`: the model's own sentences, the
 *     evidence identifiers and fixed reasons, never fetched content.
 *   - `persist` — the bundle store under the proofs root, mode 0600.
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
  verifyDocument,
} from "@crewhaus/provability";
import type { ProvabilityTurn, RunProvability } from "@crewhaus/runtime-core";
import { tenantRootOf } from "@crewhaus/tool-proof";
import { gateEvidence } from "./evidence";
import {
  type HeadDecision,
  type HeadResolver,
  SHARED_HEAD_CACHE,
  createHeadResolver,
} from "./head";
import { createWaiverJudge } from "./judge";
import { type GateCatalog, catalogReplay } from "./replay";
import { activeTenant, gateProofsRoot, gateSessionRoot } from "./roots";

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
  readonly footerTarget?: "stream" | "reply";
  /** The HEAD request behind `sources.resolve: head` (default: tool-fetch's `guardedHead`). */
  readonly resolveHead?: (url: string) => Promise<number | undefined>;
  /** Observe every bundle (the gateway envelope, the research report, tests). */
  readonly onBundle?: (bundle: ProofBundle, bundlePath?: string) => void;
  /** Test seam: the waiver judge's adapter. */
  readonly judgeAdapter?: CategoricalJudgeOptions["adapter"];
  readonly now?: () => Date;
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
  const customHead = opts.resolveHead;
  // The default guarded HEAD shares one process-wide cache, so a session
  // asks once even where the gates are wired per turn (the channel bot).
  const head: HeadResolver | undefined =
    config.sources.resolve === "head"
      ? customHead !== undefined
        ? createHeadResolver(config.sources, (url) => customHead(url))
        : createHeadResolver(config.sources, undefined, SHARED_HEAD_CACHE)
      : undefined;

  const verify = async (turn: ProvabilityTurn): Promise<ProofBundle> => {
    const tenant = activeTenant();
    const proofs = gateProofsRoot(cwd, specName, tenant);
    const sessionRootDir = gateSessionRoot(opts.sessionRootDir, tenant);
    const evidence = await gateEvidence({
      scope: config.scope,
      workspaceRoot: cwd,
      messages: turn.messages,
      ...(turn.isSynthetic !== undefined ? { isSynthetic: turn.isSynthetic } : {}),
      ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
      ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
      onUnreadable: (info) =>
        logger.warn("provability: a session log could not be read to its end", { ...info }),
    });
    const { replay, isPureTool } = catalogReplay(opts.catalog, {
      logged: loggedResults(evidence),
      ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
    });
    const record =
      turn.egressAuditSink !== undefined ? recordHead(turn.egressAuditSink) : undefined;
    const verifyOptions: VerifyOptions = {
      config,
      evidence,
      workspaceRoot: cwd,
      artifacts: createFileArtifactStore({ rootDir: proofs }),
      retryIndex: turn.retryIndex,
      ...(opts.catalog !== undefined ? { replay, isPureTool } : {}),
      ...(head !== undefined
        ? {
            resolveHead: (url: string) =>
              head(url, {
                ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
                ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
                ...(record !== undefined ? { record } : {}),
              }),
          }
        : {}),
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
    maxRetries: config.maxRetries,
    threshold: config.threshold,
    ...(config.escalateTo !== undefined ? { escalateTo: config.escalateTo } : {}),
    render: config.render,
    ...(opts.footerTarget !== undefined ? { footerTarget: opts.footerTarget } : {}),
    verify,
    ...(renderBundle !== undefined ? { renderBundle } : {}),
    nudge: renderNudge,
    persist: async (bundle, at) =>
      createBundleStore({ rootDir: gateProofsRoot(cwd, specName, activeTenant()) }).put(bundle, at),
    ...(opts.onBundle !== undefined ? { onBundle: opts.onBundle } : {}),
  };
}
