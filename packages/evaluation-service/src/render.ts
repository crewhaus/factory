/**
 * The codegen twin of `wireEvaluation` (design §4.4): what every emitter
 * renders INSTEAD of its own copy of the evaluation grader — the
 * `renderModelWiringFields` / `renderMemory` precedent. The bundle then calls
 * the same composition root the interpreter calls, so a compiled harness and
 * `crewhaus run` cannot drift on what a gate does.
 *
 * Four pieces, each the EMPTY STRING when the IR declares neither
 * `evaluation:` nor `provability:` — so every such bundle stays byte-identical
 * to its pre-0.8.0 bytes (design §1 principle 3):
 *
 *   - `imports` — `import { wireEvaluation } from "@crewhaus/evaluation-service";`
 *     (plus `registerGateTools` under `provability:`, or `mergeGateTools`
 *     when the emitter hands tools over as a list);
 *   - `bootBlock` — one line,
 *     `const __gates = await wireEvaluation(<fragment JSON>, { cwd, … });`.
 *     The deps name the catalog and the footer target only when the IR has
 *     `provability:` (an evaluation-only gate needs neither);
 *   - `field` — the `runChatLoop` fields, only for the keys the IR has:
 *     `evaluation: __gates.evaluation,` and/or `provability: __gates.provability,`;
 *   - `toolsRegistration` — under `provability:`, one
 *     `registerGateTools(<catalog>, __gates);` that puts the proof tools on
 *     the bundle's catalog, REPLACING a same-named builtin a spec also listed
 *     in `tools:` at any level (the builtin instances run under default
 *     settings and file artifacts where this spec's gate does not look —
 *     `./tools` has the rule). Emitters place it after their builtin
 *     registrations and before the plugin registration, so first-party still
 *     wins every plugin collision.
 *
 * An emitter that hands the run a tool LIST rather than a catalog snapshot
 * (the channel bot's per-turn `runTurn`) asks for `toolsInto: "list"` and
 * wraps its tools expression with `toolsExpr(…)` instead. One that serves
 * many runs from one wiring and must return each run's bundle (the managed
 * gateway) names a per-run observer with `bundleObserverExpr` (`./observe`).
 *
 * The fragment is `JSON.stringify` of `evaluationFragmentFromIr(ir)`: the
 * lowered blocks are plain data (strings, numbers, booleans, arrays), so
 * JSON's quoting is the escaping, and an inline literal argument is
 * contextually typed by `wireEvaluation`'s parameter, so the bundle
 * typechecks against the real contract.
 */
import { type EvaluationIrSlice, evaluationFragmentFromIr } from "./fragment";

/** The variable the boot line binds. */
export const GATES_VAR = "__gates";

export type EvaluationWiringOptions = {
  /**
   * The catalog EXPRESSION: where replay looks tools up and (in `"catalog"`
   * mode) where the proof tools register — `defaultCatalog`, or a tool-list
   * expression the run sees (`config.tools`).
   */
  readonly catalogVar: string;
  /** The working-directory expression (`process.cwd()`, `__cwd`). */
  readonly cwdExpr: string;
  /**
   * `"stream"` for the cli; `"reply"` where the returned text is what gets
   * sent; `"none"` where the caller carries the bundle on its own envelope
   * (the managed gateway's `proof`) and the returned text must be the answer
   * alone.
   */
  readonly footerTarget: "stream" | "reply" | "none";
  /**
   * An EXPRESSION for the footer target, in place of `footerTarget`'s
   * literal, when one emitted file serves two callers that want different
   * targets (the channel bot's `agent.ts`, shared by the daemon and the eval
   * bridge entry). `footerTarget` stays the fallback the expression is
   * written around. Ignored without `provability:`.
   */
  readonly footerTargetExpr?: string;
  /** The indent of a `runChatLoop` field line in this emitter. */
  readonly indent: string;
  /** How the proof tools reach the run (default `"catalog"`). */
  readonly toolsInto?: "catalog" | "list";
  /** An expression for the run's session-log root, when the bundle passes one to `runChatLoop`. */
  readonly sessionRootDirExpr?: string;
  /**
   * An expression for a per-run bundle observer (`ProofBundleObserver |
   * undefined`), when the emitter serves many runs from one wiring and must
   * hand each run's caller the bundle of that run (the managed gateway's
   * `proof`, design §5.4). Under `provability:` the field then reads
   * `provability: observeProofBundles(__gates.provability, <expr>),` and the
   * import names `observeProofBundles` and the `ProofBundleObserver` type.
   * Ignored without `provability:`.
   */
  readonly bundleObserverExpr?: string;
};

export type EvaluationWiring = {
  readonly imports: readonly string[];
  readonly bootBlock: string;
  readonly field: string;
  readonly toolsRegistration: string;
  /** `"list"` mode: the run's tools with the proof tools merged in; identity otherwise. */
  readonly toolsExpr: (base: string) => string;
};

const EMPTY: EvaluationWiring = {
  imports: [],
  bootBlock: "",
  field: "",
  toolsRegistration: "",
  toolsExpr: (base) => base,
};

/** The four pieces for `ir` (see the module doc). */
export function renderEvaluationWiring(
  ir: EvaluationIrSlice,
  opts: EvaluationWiringOptions,
): EvaluationWiring {
  const fragment = evaluationFragmentFromIr(ir);
  if (fragment === undefined) return EMPTY;
  const provable = fragment.provability !== undefined;
  const intoList = provable && opts.toolsInto === "list";
  const observed = provable && opts.bundleObserverExpr !== undefined;
  const helper = !provable ? "" : intoList ? "mergeGateTools, " : "registerGateTools, ";
  const observer = observed ? "type ProofBundleObserver, observeProofBundles, " : "";
  const imports = [
    `import { ${observer}${helper}wireEvaluation } from "@crewhaus/evaluation-service";`,
  ];
  const sessionRootDep =
    provable && opts.sessionRootDirExpr !== undefined
      ? `, ...(${opts.sessionRootDirExpr} !== undefined ? { sessionRootDir: ${opts.sessionRootDirExpr} } : {})`
      : "";
  const footerTarget = opts.footerTargetExpr ?? JSON.stringify(opts.footerTarget);
  const deps = provable
    ? `{ cwd: ${opts.cwdExpr}, catalog: ${opts.catalogVar}, footerTarget: ${footerTarget}${sessionRootDep} }`
    : `{ cwd: ${opts.cwdExpr} }`;
  const bootBlock = `const ${GATES_VAR} = await wireEvaluation(${JSON.stringify(fragment)}, ${deps});`;
  const field = [
    ...(fragment.evaluation !== undefined
      ? [`\n${opts.indent}evaluation: ${GATES_VAR}.evaluation,`]
      : []),
    ...(provable
      ? [
          observed
            ? `\n${opts.indent}provability: observeProofBundles(${GATES_VAR}.provability, ${opts.bundleObserverExpr}),`
            : `\n${opts.indent}provability: ${GATES_VAR}.provability,`,
        ]
      : []),
  ].join("");
  const toolsRegistration =
    provable && !intoList
      ? [
          "// 0.8.0 — the proof tools, bound to this spec's provability block; a same-named",
          "// builtin listed in tools: is replaced (it would file proofs where the gate never looks).",
          `registerGateTools(${opts.catalogVar}, ${GATES_VAR});`,
        ].join("\n")
      : "";
  return {
    imports,
    bootBlock,
    field,
    toolsRegistration,
    toolsExpr: intoList ? (base) => `mergeGateTools(${base}, ${GATES_VAR})` : (base) => base,
  };
}
