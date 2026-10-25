/**
 * The proof tools a gated harness gets (design §7): `@crewhaus/tool-proof`'s
 * three tools, bound by `createProofTools` to the SAME configuration, proofs
 * root and evidence the gate uses — so a `ProofCheck` artifact is filed where
 * the gate looks for it, and `ProvabilityPreflight` grades a draft against
 * exactly the index the gate will build.
 *
 * Which tools a level adds — decided here, once, for every shape:
 *
 *   - `ProvabilityPreflight` always: at every rung the model should see what
 *     the gate will see before it finishes (§7);
 *   - `ProofCheckers` + `ProofCheck` when the floor is `proven` — the only
 *     rung where every claim needs a `proof:` artifact (design §2) — or when
 *     the spec chose its own `formal.checkers` (anything but the lowered
 *     default `builtin, smt`): declaring checkers is a spec asking for
 *     proofs, and a `proof:` binding meets ANY floor, so a `checked` spec
 *     that named `lean4` means the model to use it. Below `proven` with the
 *     default checkers the pair is not added: a tool advertised at every
 *     turn that no claim needs is prompt weight and a distraction.
 *
 * Which tools a level adds is a separate question from which it replaces.
 * All three are always built, bound to this gate, and a tool the run already
 * carries under one of their names — a spec that listed `proofCheck` (or
 * `all-proof`) in `tools:` at `checked` — is swapped for the bound one
 * whatever the level: the builtin instance files its artifacts under
 * `.crewhaus/proofs/default/` (a run context carries no spec name), where
 * this gate never looks, so every `proof:` citation it produced would read
 * `proof_missing` — and a `proof:` binding meets any floor (design §2), so a
 * spec that listed the tool means it to work. `registerGateTools` (a
 * catalog) and `mergeGateTools` (a tool list) apply that rule; nothing else
 * should.
 *
 * The checkers: with a sandbox handed in (`deps.sandbox`), they are built
 * here over it, in `formal.checkers` order with the builtin always present
 * (tool-proof's `buildDefaultCheckers`, i.e. proof-checker's
 * `createDefaultCheckers` over the `formal` block). Without one, tool-proof
 * builds the same defaults on the first call, choosing the sandbox from what
 * the RUN says is wired (`sandboxAvailable` on the bridge, `CREWHAUS_SANDBOX`)
 * — a choice a boot-time wiring cannot make for the run.
 */
import type { IrProvability } from "@crewhaus/ir";
import type { SandboxLike } from "@crewhaus/proof-checker";
import type { Tenant } from "@crewhaus/tenancy";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import {
  type ProofToolEvidence,
  buildDefaultCheckers,
  createProofTools,
} from "@crewhaus/tool-proof";

/** The `formal.checkers` the compiler lowers when a spec names none. */
export const DEFAULT_FORMAL_CHECKERS: ReadonlyArray<string> = ["builtin", "smt"];

/**
 * Whether a gated harness also gets `ProofCheckers` + `ProofCheck` (see the
 * module doc). Reads the floor and the checkers only — the `provability`
 * skill asks the same question of the fields a bundle hands it (`./skills`),
 * so the skill teaches the proof tools exactly where they are wired.
 */
export function wantsProofCheckTools(config: {
  readonly level: IrProvability["level"];
  readonly formal: { readonly checkers: ReadonlyArray<string> };
}): boolean {
  if (config.level === "proven") return true;
  const checkers = config.formal.checkers;
  return (
    checkers.length !== DEFAULT_FORMAL_CHECKERS.length ||
    checkers.some((id, i) => id !== DEFAULT_FORMAL_CHECKERS[i])
  );
}

export type GateToolsOptions = {
  readonly config: IrProvability;
  readonly workspaceRoot: string;
  /** The proofs root for the tenant a call runs under (the gate's own resolver). */
  readonly proofsRoot: (tenant: Tenant | undefined) => string;
  /**
   * The evidence a preflight grades against: the gate's builder, without a
   * transcript — under `scope: turn` the index with the turn it keeps.
   */
  readonly evidence: (ctx: ToolExecuteContext | undefined) => Promise<ProofToolEvidence>;
  readonly sandbox?: SandboxLike;
  readonly now?: () => Date;
};

/** The proof tools for one gate: what it adds, and everything it binds. */
export type GateProofTools = {
  /** The tools the level adds to every run (see the module doc). */
  readonly tools: ReadonlyArray<RegisteredTool>;
  /**
   * All three proof tools, bound to this gate, in tool-proof's order — the
   * ones in `tools` included. A same-named tool already on the run is
   * replaced by its member here even when the level does not add it.
   */
  readonly proofTools: ReadonlyArray<RegisteredTool>;
};

/** The tools for `config`, registration-ready, in tool-proof's order. */
export function gateTools(opts: GateToolsOptions): GateProofTools {
  const sandbox = opts.sandbox;
  const tools = createProofTools({
    config: opts.config,
    proofsRoot: opts.proofsRoot,
    workspaceRoot: opts.workspaceRoot,
    evidence: opts.evidence,
    ...(sandbox !== undefined
      ? {
          checkers: buildDefaultCheckers(opts.config, {
            sandboxAvailable: true,
            createSandbox: () => sandbox,
          }),
        }
      : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const proofTools = [tools.proofCheckers, tools.proofCheck, tools.provabilityPreflight];
  return {
    tools: wantsProofCheckTools(opts.config) ? proofTools : [tools.provabilityPreflight],
    proofTools,
  };
}

/** The proof tools a run ends up with: the added ones, plus a bound twin of any it already has. */
function chosen(gate: GateProofTools, present: (name: string) => boolean): RegisteredTool[] {
  const added = new Set(gate.tools.map((tool) => tool.name));
  return gate.proofTools.filter((tool) => added.has(tool.name) || present(tool.name));
}

/**
 * Put the gate's proof tools on `catalog` — the catalog form the cli and
 * managed bundles render (`renderEvaluationWiring`): every tool the level
 * adds, and the bound twin of any proof tool already registered (a builtin
 * the spec listed), which is unregistered first. Call it after the builtin
 * registrations and before the plugin ones, so first-party still wins every
 * plugin collision.
 */
export function registerGateTools(
  catalog: {
    has(name: string): boolean;
    unregister(name: string): unknown;
    register(tool: RegisteredTool): void;
  },
  gate: GateProofTools,
): void {
  for (const tool of chosen(gate, (name) => catalog.has(name))) {
    catalog.unregister(tool.name);
    catalog.register(tool);
  }
}

/**
 * `tools` with the gate's proof tools merged in by the same rule as
 * {@link registerGateTools} — the list form, for a run that is handed a tool
 * list (the channel bot's `runTurn`, `crewhaus run` / `serve`). Order is
 * kept: the run's other tools first, then the gate's, in tool-proof's order.
 * A copy, never the caller's array.
 */
export function mergeGateTools(
  tools: ReadonlyArray<RegisteredTool>,
  gate: GateProofTools,
): RegisteredTool[] {
  if (gate.proofTools.length === 0) return [...tools];
  const present = new Set(tools.map((tool) => tool.name));
  const merged = chosen(gate, (name) => present.has(name));
  const names = new Set(merged.map((tool) => tool.name));
  return [...tools.filter((tool) => !names.has(tool.name)), ...merged];
}
