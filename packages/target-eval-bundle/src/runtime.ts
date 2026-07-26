/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the RUNTIME half of the eval
 * bridge: the helpers a bridged `target: eval` bundle imports so its samples
 * drive the source shape's ACTUAL compiled runtime instead of a bare
 * single-turn chat projection.
 *
 * Two pieces, both imported by the generated bundle (see `emitEval`'s
 * `bridge` option in index.ts):
 *
 *   1. `createBridgeInvoker(bridge, entry)` — wraps the compiled bundle's
 *      exported runtime entry (`runForEval` for workflow/graph/crew/pipeline/
 *      channel, the managed bundle's existing `runOneTurn`) into the
 *      eval-runner `opts.invoker` seam. The runner's per-sample RunContext /
 *      sessionRootDir thread through, so the runtime's trace-bus events and
 *      session transcripts land in the per-sample artifacts wherever the
 *      entry supports them.
 *   2. `guardHistorySamples(samples, bridge)` — the LOAD-TIME history gate:
 *      a multi-turn sample (`history` present) against a non-chat-capable
 *      shape fails loudly before any agent is invoked, instead of silently
 *      seeding a conversation into a runtime that consumes a single trigger
 *      input.
 *
 * Types are STRUCTURAL mirrors of the eval-runner seam (`AgentInvoker` /
 * `AgentInvokeRequest`) so this package takes no dependency on
 * `@crewhaus/eval-runner` — the generated bundle already depends on both and
 * the shapes are pinned by the bridge smoke tests.
 */
import { join } from "node:path";
import { buildTenant } from "@crewhaus/tenancy";

/** One seeded conversation turn (the eval-dataset `history` entry shape). */
export type BridgeHistoryMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

/** Structural mirror of the eval-dataset `Sample` fields the bridge reads. */
export type BridgeSample = {
  readonly id: string;
  readonly input: string;
  readonly history?: ReadonlyArray<BridgeHistoryMessage>;
};

/** Structural mirror of eval-runner's `AgentInvokeRequest`. */
export type BridgeInvokeRequest = {
  readonly sample: BridgeSample;
  /** The runner's per-sample RunContext (fresh bus + sessionId). Kept
   *  structural; the real object is passed through to the entry verbatim. */
  readonly runContext: { readonly sessionId: string };
  readonly sessionRootDir: string;
  readonly seed?: number;
};

/** Structural mirror of eval-runner's `AgentInvokeResult`. */
export type BridgeInvokeResult = { readonly agentOutput: string };

export type BridgeInvoker = (req: BridgeInvokeRequest) => Promise<BridgeInvokeResult>;

/**
 * The per-shape invoker strategies the bridge implements or documents.
 * Entry-driven kinds (workflow-run / graph-run / crew-run / pipeline-query /
 * channel-resume-turn / gateway-request) wrap a compiled runtime entry;
 * the rest drive the eval-runner default single-turn invoker over the
 * shape's projected agent (real tools/MCP wired by the runner) with the
 * fidelity notes recorded in the CLI's `selectInvoker` strategy text.
 */
export type BridgeInvokerKind =
  | "single-turn-chat-loop"
  | "workflow-run"
  | "graph-run"
  | "crew-run"
  | "pipeline-query"
  | "channel-resume-turn"
  | "gateway-request"
  | "voice-replay"
  | "chain-trigger"
  | "batch-item";

/** The bridge descriptor the generated bundle embeds as a literal. */
export type EvalBridge = {
  /** The source shape the eval bundle was projected from. */
  readonly sourceTarget: string;
  readonly kind: BridgeInvokerKind;
  /**
   * Whether sample `history` may seed this shape (channel / managed / voice /
   * pipeline — shapes whose runtime consumes a conversation). Non-chat shapes
   * reject history-carrying samples loudly at load (`guardHistorySamples`).
   */
  readonly chatCapable: boolean;
  /** Relative import (from the eval bundle dir) of the compiled runtime
   *  entry module, for the entry-driven kinds. */
  readonly entryImport?: string;
};

/** Thrown on a bridge misconfiguration or a history-vs-shape mismatch. */
export class EvalBridgeRuntimeError extends Error {
  override readonly name = "EvalBridgeRuntimeError";
}

type RunForEvalFn = (input: string, opts?: Record<string, unknown>) => Promise<string>;
type RunOneTurnFn = (args: Record<string, unknown>) => Promise<string>;

/** The kinds that wrap a compiled entry module, with the export they expect. */
const ENTRY_EXPORT_BY_KIND: Readonly<Partial<Record<BridgeInvokerKind, string>>> = {
  "workflow-run": "runForEval",
  "graph-run": "runForEval",
  "crew-run": "runForEval",
  "pipeline-query": "runForEval",
  "channel-resume-turn": "runForEval",
  "gateway-request": "runOneTurn",
};

function requireEntryFn(bridge: EvalBridge, entry: Record<string, unknown>): unknown {
  const exportName = ENTRY_EXPORT_BY_KIND[bridge.kind];
  if (exportName === undefined) {
    throw new EvalBridgeRuntimeError(
      `bridge kind "${bridge.kind}" drives the eval-runner default single-turn invoker — createBridgeInvoker has no compiled entry to wrap for it`,
    );
  }
  const fn = entry[exportName];
  if (typeof fn !== "function") {
    throw new EvalBridgeRuntimeError(
      `the compiled ${bridge.sourceTarget} bundle does not export ${exportName}() — recompile the primary bundle with \`crewhaus compile --with-eval-harness\` (the eval-entry variant emits it)`,
    );
  }
  return fn;
}

export type CreateBridgeInvokerOptions = {
  /** Test seam: a scripted ProviderAdapter threaded into the entry so bridge
   *  smoke tests run without credentials. Never set by generated bundles. */
  readonly _adapter?: unknown;
};

/**
 * Wrap a compiled runtime entry module into an eval-runner invoker. Throws
 * `EvalBridgeRuntimeError` (loud, at bundle boot) when the entry module does
 * not export the hook the bridge kind expects, or when the kind has no entry
 * to wrap (those shapes use the runner's default invoker — the generated
 * bundle never calls this for them).
 */
export function createBridgeInvoker(
  bridge: EvalBridge,
  entry: Record<string, unknown>,
  opts: CreateBridgeInvokerOptions = {},
): BridgeInvoker {
  const fn = requireEntryFn(bridge, entry);

  if (bridge.kind === "gateway-request") {
    const runOneTurn = fn as RunOneTurnFn;
    return async (req) => {
      const seedMessages = [
        ...(req.sample.history ?? []),
        { role: "user", content: req.sample.input },
      ];
      const agentOutput = await runOneTurn({
        tenantId: "eval",
        sessionId: req.runContext.sessionId,
        input: req.sample.input,
        // Per-SAMPLE tenant rooted inside the sample's artifact dir, so the
        // managed memory fabric (which fences every store on the tenant)
        // stays isolated between samples — the §7.2 posture the default
        // invoker enforces, expressed through the shape's own tenancy seam.
        tenant: buildTenant("eval", { tenantsRoot: join(req.sessionRootDir, "tenants") }),
        extraOptions: {
          runContext: req.runContext,
          sessionRootDir: req.sessionRootDir,
          seedMessages,
          ...(opts._adapter !== undefined ? { _adapter: opts._adapter } : {}),
        },
      });
      return { agentOutput };
    };
  }

  const runForEval = fn as RunForEvalFn;
  return async (req) => {
    const agentOutput = await runForEval(req.sample.input, {
      runContext: req.runContext,
      sessionRootDir: req.sessionRootDir,
      sessionId: req.runContext.sessionId,
      ...(bridge.chatCapable && req.sample.history !== undefined
        ? { history: req.sample.history }
        : {}),
      ...(opts._adapter !== undefined ? { _adapter: opts._adapter } : {}),
    });
    return { agentOutput };
  };
}

/**
 * LOAD-TIME history gate: pass samples through untouched, but fail loudly on
 * the first history-carrying sample when the bundle DRIVES a compiled runtime
 * entry that consumes a single trigger input. The eval-runner materializes the
 * sample iterable BEFORE any agent invocation, so the throw aborts the run at
 * load with zero spend.
 *
 * The gate is keyed on `entryImport` — the real condition — not on
 * `chatCapable` alone. A bridged shape with NO entry (research / browser /
 * onchain / onchain-game / batch / voice) runs the eval-runner's DEFAULT
 * single-turn invoker, which is itself a chat loop and seeds `history`
 * natively (Wave-3 B14); rejecting those samples would revoke a shipped
 * capability for no runtime reason. Only entry-driven, non-chat kinds
 * (workflow-run / graph-run / crew-run) have nowhere to put a conversation.
 */
export async function* guardHistorySamples<S extends BridgeSample>(
  samples: AsyncIterable<S>,
  bridge: Pick<EvalBridge, "sourceTarget" | "chatCapable" | "entryImport">,
): AsyncIterable<S> {
  const rejects = bridge.entryImport !== undefined && !bridge.chatCapable;
  for await (const sample of samples) {
    if (rejects && sample.history !== undefined && sample.history.length > 0) {
      throw new EvalBridgeRuntimeError(
        `sample "${sample.id}" carries a multi-turn history, but the bridged target: ${bridge.sourceTarget} shape is driven through its compiled runtime entry (${bridge.entryImport}), which consumes a single trigger input rather than a seeded conversation. Remove the sample's history (or eval a shape whose runtime is a conversation: channel, managed, pipeline).`,
      );
    }
    yield sample;
  }
}
