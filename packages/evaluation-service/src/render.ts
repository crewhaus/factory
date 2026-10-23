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
 * wraps its tools expression with `toolsExpr(…)` instead.
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
  /** `"stream"` for the cli; `"reply"` where the returned text is what gets sent. */
  readonly footerTarget: "stream" | "reply";
  /** The indent of a `runChatLoop` field line in this emitter. */
  readonly indent: string;
  /** How the proof tools reach the run (default `"catalog"`). */
  readonly toolsInto?: "catalog" | "list";
  /** An expression for the run's session-log root, when the bundle passes one to `runChatLoop`. */
  readonly sessionRootDirExpr?: string;
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
  const helper = !provable ? "" : intoList ? "mergeGateTools, " : "registerGateTools, ";
  const imports = [`import { ${helper}wireEvaluation } from "@crewhaus/evaluation-service";`];
  const sessionRootDep =
    provable && opts.sessionRootDirExpr !== undefined
      ? `, ...(${opts.sessionRootDirExpr} !== undefined ? { sessionRootDir: ${opts.sessionRootDirExpr} } : {})`
      : "";
  const deps = provable
    ? `{ cwd: ${opts.cwdExpr}, catalog: ${opts.catalogVar}, footerTarget: ${JSON.stringify(opts.footerTarget)}${sessionRootDep} }`
    : `{ cwd: ${opts.cwdExpr} }`;
  const bootBlock = `const ${GATES_VAR} = await wireEvaluation(${JSON.stringify(fragment)}, ${deps});`;
  const field = [
    ...(fragment.evaluation !== undefined
      ? [`\n${opts.indent}evaluation: ${GATES_VAR}.evaluation,`]
      : []),
    ...(provable ? [`\n${opts.indent}provability: ${GATES_VAR}.provability,`] : []),
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
