/**
 * @crewhaus/tool-proof — the tools a harness proves claims with and checks
 * a draft with before it answers (design/0.8.0-provability-release.md §7).
 *
 *   ProofCheckers         which proof checkers this harness can use, whether
 *                         each can run here, and the language each checks
 *   ProofCheck            run a checker on a proof and save the verdict as a
 *                         `prf_…` artifact the `proven` rung can cite
 *   ProvabilityPreflight  grade a draft with the gate's own verifier,
 *                         without gating
 *
 * Nothing here cites for the model and nothing calls a model. A checker's
 * exit status is the only thing `ProofCheck` trusts, and the preflight is
 * `verifyDocument` — the function the gate calls — over the same evidence.
 *
 * `createProofTools` binds the three tools to one configuration: the
 * composition root (`@crewhaus/evaluation-service`) calls it with the spec's
 * lowered `provability:` block, so the gate and the tools agree on the
 * floor, the checkers, the artifacts root and the evidence. The roots are
 * resolved per call, for the tenant the call runs under: an instance built
 * once at boot serves every tenant of a managed daemon (see
 * {@link CreateProofToolsOptions.proofsRoot}). The exported
 * builtin instances are what a spec gets by listing `proofCheck` (or
 * `all-proof`) in `tools:` with no `provability:` block: the compiler's
 * defaults at the `grounded` floor, checkers in `builtin, smt` order,
 * artifacts under `<cwd>/.crewhaus/proofs/default/` (under the tenant's root
 * inside a managed turn, see `./lib/roots`), and the run's own session log
 * as evidence.
 *
 * Each tool is a thin wrapper over `./lib`, where the behaviour lives.
 */
import { CrewhausError } from "@crewhaus/errors";
import {
  type CheckerRegistry,
  type ProofChecker,
  createCheckerRegistry,
} from "@crewhaus/proof-checker";
import {
  type EvidenceIndex,
  type ProvabilityConfig,
  createFileArtifactStore,
  newProofId,
  proofsRoot as proofsRootFor,
} from "@crewhaus/provability";
import { createSandbox, sandboxAvailableFromEnv } from "@crewhaus/sandbox";
import { type Tenant, currentTenantContext } from "@crewhaus/tenancy";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  CHECK_GRACE_MS,
  PROOF_INPUT_LIMITS,
  checkReport,
  clip,
  proofCheckedFields,
  runChecker,
  toArtifact,
} from "./lib/check";
import { buildDefaultCheckers, listCheckers, probeChecker } from "./lib/checkers";
import { DEFAULT_SPEC_NAME, assertConfig, defaultProvabilityConfig } from "./lib/config";
import {
  bridgeSandboxAvailable,
  eventBusOf,
  eventLogOf,
  sessionIdOf,
  sessionRootOf,
  specNameOf,
  warn,
} from "./lib/context";
import { sessionEvidence } from "./lib/evidence";
import { DRAFT_CHARS, preflightBundle, preflightReport } from "./lib/preflight";
import { proofRecheck } from "./lib/recheck";
import { defaultProofsRoot, defaultSessionRoot, fenced, runtimeStateRoots } from "./lib/roots";

export {
  AVAILABILITY_TIMEOUT_MS,
  BUILTIN_ID,
  type CheckerListing,
  type DefaultCheckerDeps,
  buildDefaultCheckers,
  defaultCheckerIds,
  listCheckers,
  probeChecker,
  sandboxImages,
} from "./lib/checkers";
export {
  CHECK_GRACE_MS,
  OUTPUT_CHARS,
  PROOF_INPUT_LIMITS,
  REPORT_BYTES,
  type RunCheckerOptions,
  checkReport,
  runChecker,
  toArtifact,
} from "./lib/check";
export {
  DEFAULT_EXECUTION_SELECTORS,
  DEFAULT_FLOOR,
  DEFAULT_SPEC_NAME,
  defaultProvabilityConfig,
} from "./lib/config";
export { type SessionEvidence, currentTurn, sessionEvidence, startsTurn } from "./lib/evidence";
export {
  DRAFT_CHARS,
  NOTES_BYTES,
  ROW_BINDINGS,
  TABLE_ROWS,
  preflightBundle,
  preflightConfig,
  preflightReport,
} from "./lib/preflight";
export { type RecheckProofOptions, proofRecheck, recheckProof } from "./lib/recheck";
export {
  STATE_ENV_VARS,
  defaultProofsRoot,
  defaultSessionRoot,
  runtimeStateRoots,
  tenantRootOf,
} from "./lib/roots";

/** Compact JSON — the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

/** A call the tools refuse: an unknown or unavailable checker, an artifact that could not be saved. */
export class ProofToolError extends CrewhausError {
  override readonly name = "ProofToolError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

/**
 * What an injected evidence builder returns: the index alone when it is
 * already restricted to `config.scope`, or the index with the turns
 * `scope: turn` keeps (`VerifyOptions.turnNumbers`), which the preflight
 * forwards to the verifier exactly as the gate does.
 */
export type ProofToolEvidence =
  | EvidenceIndex
  | { readonly index: EvidenceIndex; readonly turnNumbers?: ReadonlySet<number> };

/**
 * A directory fixed for the instance's life, or resolved on every call from
 * the tenant the call runs under (`undefined` outside any tenant scope).
 */
export type ProofToolsRoot = string | ((tenant: Tenant | undefined) => string);

export type CreateProofToolsOptions = {
  /**
   * The lowered `provability:` block (`IrProvability`) the gate runs under.
   * Absent: the compiler's defaults at the `grounded` floor.
   */
  readonly config?: ProvabilityConfig;
  /**
   * Whose proofs these are: artifacts go under
   * `<workspaceRoot>/.crewhaus/proofs/<specName>/artifacts/` (inside a
   * tenant scope, `<tenantRoot>/proofs/<specName>/artifacts/`). Absent: the
   * spec name the run carries, else `default`. Ignored when `proofsRoot` is set.
   */
  readonly specName?: string;
  /**
   * The proofs root itself, for a caller that resolves it rather than naming
   * `specName`. Inside a tenant scope the root a call resolves must lie
   * under that tenant's root, or the call is refused (`TenancyError`).
   *
   * So a fixed string suits a CLI run or a single-tenant daemon only. A
   * composition root that builds the tools once at boot and serves every
   * tenant — a managed daemon — must NOT pass the boot-time
   * `proofsRoot(cwd, specName)`: no tenant exists at boot, and that root
   * fails every managed call. It either omits this (passing `specName` and
   * `workspaceRoot`; the tools then resolve `<tenantRoot>/proofs/<spec>`
   * per call, `<workspaceRoot>/.crewhaus/proofs/<spec>` outside a tenant),
   * or passes a function of the call's tenant, e.g.
   * `(tenant) => defaultProofsRoot(cwd, specName, tenant)`. The gate's own
   * artifact and bundle stores resolve the same way, per turn —
   * `defaultProofsRoot(cwd, specName, currentTenantContext()?.tenant)` —
   * so a citation the tools filed resolves at the gate.
   */
  readonly proofsRoot?: ProofToolsRoot;
  /** Where path sources resolve and `.crewhaus/` lives (default: `process.cwd()` at call time). */
  readonly workspaceRoot?: string;
  /**
   * The checkers, in preference order. Absent: `createDefaultCheckers` over
   * `config.formal` with the builtin always present, the sandbox checkers
   * given a container sandbox when one is available.
   */
  readonly checkers?: ReadonlyArray<ProofChecker>;
  /**
   * Where session `.jsonl` logs live. Default: the run's, else the active
   * tenant's `sessionRoot`, else `CREWHAUS_SESSION_DIR`, else
   * `.crewhaus/sessions` — the runtime's own order. Inside a tenant scope
   * the root a call resolves must lie under the tenant's root: as with
   * `proofsRoot`, a shared instance omits it or passes a function of the
   * call's tenant. Unused when `evidence` is injected.
   */
  readonly sessionRootDir?: ProofToolsRoot;
  /**
   * The evidence a preflight grades against. Absent: the run's session log
   * (`ctx.runContext.sessionId`), scoped by `config.scope`. The gate's
   * composition root passes the builder its verifier uses. Under
   * `scope: turn` the builder returns either an index already restricted to
   * the turn, or `{ index, turnNumbers }` for the preflight to restrict the
   * way the gate does — never a session-wide index alone, which would let
   * an earlier turn's reading ground this turn's draft.
   */
  readonly evidence?: (ctx: ToolExecuteContext | undefined) => Promise<ProofToolEvidence>;
  /**
   * The longest one check may take before it is saved as a rejection.
   * Default: `config.formal.timeoutMs` + {@link CHECK_GRACE_MS}.
   */
  readonly checkTimeoutMs?: number;
  /** Clock for `checkedAt` and bundle timestamps (tests). */
  readonly now?: () => Date;
};

export type ProofTools = {
  readonly proofCheckers: RegisteredTool;
  readonly proofCheck: RegisteredTool;
  readonly provabilityPreflight: RegisteredTool;
  /** The three tools, registration-ready. */
  readonly all: readonly RegisteredTool[];
};

const checkersSchema = z.object({});

const checkSchema = z.object({
  checker: z
    .string()
    .min(1)
    .max(PROOF_INPUT_LIMITS.checkerChars)
    .describe("The checker to use: an id ProofCheckers lists as available (builtin, smt, lean4)."),
  claim: z
    .string()
    .min(1)
    .max(PROOF_INPUT_LIMITS.claimChars)
    .describe(
      "The sentence your answer will carry, as you will write it. The gate checks that the cited sentence states it.",
    ),
  statement: z
    .string()
    .min(1)
    .max(PROOF_INPUT_LIMITS.statementChars)
    .describe("The claim as a formal statement, in the checker's language."),
  proof: z
    .string()
    .min(1)
    .max(PROOF_INPUT_LIMITS.proofChars)
    .describe("The proof, certificate or problem, in the checker's language."),
});

const isEvidenceIndex = (value: unknown): value is EvidenceIndex =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as EvidenceIndex).all === "function" &&
  typeof (value as EvidenceIndex).bySource === "function" &&
  typeof (value as EvidenceIndex).byToolUseId === "function";

const preflightSchema = z.object({
  draft: z
    .string()
    .min(1)
    .max(DRAFT_CHARS)
    .describe("Your draft answer, exactly as you would send it, with its citation lines."),
});

/**
 * Build the three proof tools over one configuration (see the module doc).
 * Nothing is created here — no sandbox, no directory, no log read: each
 * tool resolves what it needs on its first call.
 */
export function createProofTools(opts: CreateProofToolsOptions = {}): ProofTools {
  const now = opts.now ?? ((): Date => new Date());
  if (opts.config !== undefined) assertConfig(opts.config);
  // A bad name is the caller's mistake: refuse it here, not on every call.
  if (opts.specName !== undefined) proofsRootFor(".", opts.specName);
  // Duplicate ids are refused by the registry, also at construction.
  const injected = opts.checkers !== undefined ? createCheckerRegistry(opts.checkers) : undefined;

  let config: ProvabilityConfig | undefined = opts.config;
  const configOf = (): ProvabilityConfig => {
    config ??= defaultProvabilityConfig();
    return config;
  };

  // The default checkers are built once, on first use, and kept: the
  // sandbox checkers remember their image probe across calls.
  let defaults: CheckerRegistry | undefined;
  const registryFor = (ctx: ToolExecuteContext | undefined): CheckerRegistry => {
    if (injected !== undefined) return injected;
    defaults ??= createCheckerRegistry(
      buildDefaultCheckers(configOf(), {
        sandboxAvailable: bridgeSandboxAvailable(ctx) || sandboxAvailableFromEnv(),
        createSandbox: (sandboxOpts) => createSandbox({ allowedImages: sandboxOpts.allowedImages }),
      }),
    );
    return defaults;
  };

  const workspaceRoot = (): string => opts.workspaceRoot ?? process.cwd();
  // The tenant is read per call: it is the request's (AsyncLocalStorage),
  // and one tools instance serves every tenant of a managed daemon.
  const tenantNow = () => currentTenantContext()?.tenant;
  const rootFor = (
    option: ProofToolsRoot | undefined,
    tenant: Tenant | undefined,
    what: string,
  ): string | undefined => {
    if (typeof option !== "function") return option;
    const dir = option(tenant);
    if (typeof dir !== "string" || dir === "") {
      throw new ProofToolError(`the ${what} resolver returned no directory; nothing was done`);
    }
    return dir;
  };
  /** Where proofs are filed and read for this call, fenced to the active tenant. */
  const proofsDirFor = (ctx: ToolExecuteContext | undefined): string => {
    const tenant = tenantNow();
    const rootDir =
      rootFor(opts.proofsRoot, tenant, "proofsRoot") ??
      defaultProofsRoot(
        workspaceRoot(),
        opts.specName ?? specNameOf(ctx) ?? DEFAULT_SPEC_NAME,
        tenant,
      );
    return fenced(rootDir, tenant);
  };
  const artifactsFor = (ctx: ToolExecuteContext | undefined) =>
    createFileArtifactStore({ rootDir: proofsDirFor(ctx) });

  /** The session-log root a preflight reads, when one was chosen (else event-log's default). */
  const sessionRootFor = (ctx: ToolExecuteContext | undefined): string | undefined => {
    const tenant = tenantNow();
    const chosen =
      rootFor(opts.sessionRootDir, tenant, "sessionRootDir") ??
      sessionRootOf(ctx) ??
      defaultSessionRoot(tenant);
    // Event-log's default (`.crewhaus/sessions`, cwd-relative) when none was
    // chosen; under a tenant one always is, and it must be the tenant's.
    return chosen !== undefined ? fenced(chosen, tenant) : undefined;
  };

  const evidenceFor = async (
    ctx: ToolExecuteContext | undefined,
    scope: ProvabilityConfig["scope"],
  ): Promise<{
    readonly index: EvidenceIndex;
    readonly turnNumbers?: ReadonlySet<number>;
    readonly notes: ReadonlyArray<string>;
  }> => {
    if (opts.evidence !== undefined) {
      let built: unknown;
      try {
        built = await opts.evidence(ctx);
      } catch (err) {
        throw new ProofToolError(
          `ProvabilityPreflight could not read this run's evidence: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      if (isEvidenceIndex(built)) return { index: built, notes: [] };
      const scoped = built as { index?: unknown; turnNumbers?: unknown } | null;
      if (typeof scoped === "object" && scoped !== null && isEvidenceIndex(scoped.index)) {
        if (scoped.turnNumbers !== undefined && !(scoped.turnNumbers instanceof Set)) {
          throw new ProofToolError(
            "ProvabilityPreflight could not read this run's evidence: turnNumbers must be a Set of turn numbers",
          );
        }
        return {
          index: scoped.index,
          ...(scoped.turnNumbers !== undefined
            ? { turnNumbers: scoped.turnNumbers as ReadonlySet<number> }
            : {}),
          notes: [],
        };
      }
      // Grading against nothing would fail every claim as not fetched: refuse.
      throw new ProofToolError(
        "ProvabilityPreflight could not read this run's evidence: the evidence builder returned no evidence index",
      );
    }
    const tenant = tenantNow();
    const sessionId = sessionIdOf(ctx);
    const rootDir = sessionRootFor(ctx);
    return sessionEvidence({
      scope,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(rootDir !== undefined ? { rootDir } : {}),
      ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}),
      // Inside a tenant scope the runtime spills to the tenant's root.
      ...(tenant !== undefined ? { toolResultsRoot: tenant.toolResultRoot } : {}),
      onUnreadable: (info) =>
        warn(ctx, "tool-proof: a session log could not be read to its end", { ...info }),
    });
  };

  /** "available: builtin; listed but not available here: smt (why)". */
  const describeCheckers = async (registry: CheckerRegistry): Promise<string> => {
    const listing = await listCheckers(registry.list());
    const up = listing.filter((c) => c.available).map((c) => c.id);
    const down = listing.filter((c) => !c.available).map((c) => c.id);
    return [
      `available: ${up.length > 0 ? up.join(", ") : "none"}`,
      ...(down.length > 0 ? [`listed but not available here: ${down.join(", ")}`] : []),
    ].join("; ");
  };

  const proofCheckers: RegisteredTool = buildTool({
    name: "ProofCheckers",
    description:
      "List the proof checkers this harness can prove claims with, in preference order: whether each can run here (and why not), and the statement language each one checks. Use it before ProofCheck, so you write the statement and the proof in a language an available checker accepts.",
    inputSchema: checkersSchema,
    readOnly: true,
    concurrencySafe: true,
    execute: async (_input, ctx) => {
      const listing = await listCheckers(registryFor(ctx).list());
      return json({
        floor: configOf().level,
        checkers: listing,
        usage:
          "Run ProofCheck with { checker, claim, statement, proof }, using the first available checker whose language can state the claim. On ok, cite the returned id as [n]: proof:<id> on the sentence that states the claim. A proof meets any floor.",
      });
    },
  });

  const proofCheck: RegisteredTool = buildTool({
    name: "ProofCheck",
    description:
      "Check a formal proof of one claim with a proof checker and save the verdict as a proof artifact. Give the checker id (see ProofCheckers), the claim sentence as your answer will state it, the formal statement, and the proof in that checker's language. Use it to back a claim with a machine-checked proof: on ok, cite the returned id as [n]: proof:<id>. A rejected proof is saved too, with the checker's reason and any counterexample, so fix the proof or drop the claim.",
    inputSchema: checkSchema,
    // Writes one new, immutable artifact file per call.
    readOnly: false,
    destructive: true,
    // The one choice a call makes about where it acts is which checker
    // runs: the builtin (a worker thread, no sandbox), or a container (smt,
    // lean4). The artifact's place is fixed by the configuration, never by
    // the call. Declaring it lets an operator allow the sandbox-free checker
    // alone — `alwaysAllow ProofCheck(builtin)` — and ask before the rest.
    operativeArgs: [{ field: "checker", kind: "id" }],
    // Each call writes its own uniquely named artifact and shares no state with
    // another, so two checks may run side by side.
    concurrencySafe: true,
    // NOT requiresSandbox: the builtin checker is a parser, not an executor,
    // and needs none. The sandbox checkers (smt, lean4) refuse themselves when
    // no container sandbox is wired, and on the noop backend (proof-checker's
    // sandbox-common), so the floor is per checker, not per tool — a
    // tool-level flag would deny the builtin on every sandbox-less harness.
    execute: async (input, ctx) => {
      const registry = registryFor(ctx);
      const checker = registry.get(input.checker);
      if (checker === undefined) {
        throw new ProofToolError(
          `unknown proof checker "${clip(input.checker, 64)}" — ${await describeCheckers(registry)}. Run ProofCheckers to see what each one proves.`,
        );
      }
      const availability = await probeChecker(checker);
      if (!availability.ok) {
        throw new ProofToolError(
          `the ${checker.id} checker cannot run here: ${availability.reason ?? "unavailable"} — ${await describeCheckers(registry)}. Nothing was checked or saved.`,
        );
      }
      // Resolved (and tenant-fenced) before the check runs: a root the call
      // may not write is refused before any work, not after it.
      const artifacts = artifactsFor(ctx);
      const result = await runChecker(checker, input, {
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
        timeoutMs: opts.checkTimeoutMs ?? configOf().formal.timeoutMs + CHECK_GRACE_MS,
      });
      if (ctx?.signal?.aborted === true) {
        // A cancelled check is not a verdict on the proof.
        throw new ProofToolError("ProofCheck was cancelled; nothing was saved");
      }
      const artifact = toArtifact({
        id: newProofId(),
        checker,
        input,
        result,
        checkedAt: now(),
      });
      try {
        await artifacts.put(artifact);
      } catch (err) {
        throw new ProofToolError(
          `the ${checker.id} checker ${artifact.ok ? "accepted" : "rejected"} the proof, but the artifact could not be saved, so it cannot be cited: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      const fields = proofCheckedFields(artifact);
      // The trace event: fire-and-forget, like every bus publish.
      const bus = eventBusOf(ctx);
      if (bus !== undefined) {
        try {
          bus.publish({ ...bus.envelope(), kind: "proof_checked", ...fields });
        } catch (err) {
          warn(ctx, "tool-proof: proof_checked could not be published", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // The durable twin: the run's session event log, which the bridge hands
      // to tools (`RuntimeBridge.eventLog`). The artifact file is the record a
      // citation resolves against; the log line mirrors it, so a failed append
      // is logged rather than turning a finished check into an error.
      const log = eventLogOf(ctx);
      if (log !== undefined) {
        try {
          await log.append({ kind: "proof_checked", payload: fields });
        } catch (err) {
          warn(ctx, "tool-proof: proof_checked could not be appended to the event log", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return json(checkReport(artifact));
    },
  });

  const provabilityPreflight: RegisteredTool = buildTool({
    name: "ProvabilityPreflight",
    description:
      "Check a draft answer against the provability gate before you send it. Runs the verifier the gate runs, over the evidence this session has gathered, and returns the verdict, each claim with its evidence and status, and what to fix. Sends nothing and gates nothing. Use it on your final draft whenever your answers must carry cited, grounded, checked or proven claims.",
    inputSchema: preflightSchema,
    readOnly: true,
    concurrencySafe: true,
    execute: async (input, ctx) => {
      const config = configOf();
      const artifacts = artifactsFor(ctx);
      const evidence = await evidenceFor(ctx, config.scope);
      const tenant = tenantNow();
      const sessionRootDir = sessionRootFor(ctx);
      const { bundle, notes } = await preflightBundle(input.draft, {
        config,
        evidence: evidence.index,
        artifacts,
        workspaceRoot: workspaceRoot(),
        // The directories the gate refuses path sources under, as the gate
        // names them (`runtimeStateRoots`), so the two agree (design §6).
        stateRoots: runtimeStateRoots({
          workspaceRoot: workspaceRoot(),
          proofsRoot: proofsDirFor(ctx),
          ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
          ...(tenant !== undefined ? { tenant } : {}),
        }),
        ...(evidence.turnNumbers !== undefined ? { turnNumbers: evidence.turnNumbers } : {}),
        // The gate's re-check of a stored builtin proof, so a draft resting
        // on a rewritten artifact is told what the gate will say.
        recheckProof: proofRecheck({
          timeoutMs: config.formal.timeoutMs,
          ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
        }),
        now,
      });
      return json(preflightReport(bundle, [...evidence.notes, ...notes]));
    },
  });

  return {
    proofCheckers,
    proofCheck,
    provabilityPreflight,
    all: [proofCheckers, proofCheck, provabilityPreflight],
  };
}

/**
 * The builtin instances (see the module doc). Building them creates
 * nothing: the default config, checkers and sandbox are resolved on the
 * first call.
 */
const BUILTIN_PROOF_TOOLS = createProofTools();

export const proofCheckers: RegisteredTool = BUILTIN_PROOF_TOOLS.proofCheckers;
export const proofCheck: RegisteredTool = BUILTIN_PROOF_TOOLS.proofCheck;
export const provabilityPreflight: RegisteredTool = BUILTIN_PROOF_TOOLS.provabilityPreflight;

/** Every builtin proof tool, registration-ready. */
export const PROOF_TOOLS: readonly RegisteredTool[] = BUILTIN_PROOF_TOOLS.all;
