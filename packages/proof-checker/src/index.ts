/**
 * @crewhaus/proof-checker — pluggable proof checkers behind the `proven` rung
 * (design/0.8.0-provability-release.md §6.4).
 *
 * A checker CHECKS; the model searches. Three ship:
 *   - `builtin` — a dependency-free certificate checker for finite,
 *     arithmetic and propositional claims; always available, no sandbox,
 *     each check on a worker thread of its own;
 *   - `smt` — SMT-LIB 2 checked by Z3 in a sandbox
 *     (`@crewhaus/sandbox-image-z3`);
 *   - `lean4` — Lean 4 in a sandbox (`@crewhaus/sandbox-image-lean4`), behind
 *     a deterministic pre-scan.
 * No model call anywhere in this package.
 */
export * from "./types";
export { BUILTIN_LIMITS } from "./builtin/budget";
export {
  BUILTIN_CHECKER_ID,
  BUILTIN_LANGUAGE,
  BUILTIN_RULES,
  type BuiltinRule,
  type BuiltinVerdict,
  checkCertificate,
} from "./builtin/checker";
export {
  type BuiltinCheckerOptions,
  builtinCheckerCounts,
  createBuiltinChecker,
  stoppedWithoutVerdict,
} from "./builtin/runner";
export {
  type SExpr,
  SMT_CHECKER_ID,
  SMT_LANGUAGE,
  SMT_LIMITS,
  SMT_NAME_PATTERN,
  SMT_PREAMBLE_COMMANDS,
  SMT_RESERVED_NAMES,
  SMT_RESERVED_SORTS,
  type SmtAnswer,
  type SmtCheckerOptions,
  type SmtOutcome,
  type SmtProblem,
  buildSmtScript,
  createSmtChecker,
  formatModel,
  isReservedSmtName,
  parseSExprs,
  parseSmtOutput,
  printSExpr,
} from "./smt";
export {
  LEAN4_CHECKER_ID,
  LEAN4_COMMAND_WORDS,
  LEAN4_CORE_IMPORTS,
  LEAN4_DEFAULT_FORBID,
  LEAN4_LANGUAGE,
  LEAN4_LIMITS,
  LEAN4_OVERRIDE_IMPORTS,
  LEAN4_STANDARD_AXIOMS,
  LEAN4_THEOREM_NAME,
  type Lean4CheckerOptions,
  type LeanFile,
  type LeanLexed,
  type LeanMessage,
  type LeanPrescanOptions,
  createLean4Checker,
  lexLean,
  parseLeanOutput,
  prescanLean,
  readAxioms,
  stripLean,
} from "./lean4";
export {
  DEFAULT_SANDBOX_TIMEOUT_MS,
  type SandboxCheckerOptions,
  type SandboxProofChecker,
} from "./sandbox-common";
export {
  type CheckerRegistry,
  DEFAULT_CHECKER_IDS,
  type DefaultCheckersOptions,
  KNOWN_CHECKER_IDS,
  type KnownCheckerId,
  ProofCheckerConfigError,
  checkerImages,
  createCheckerRegistry,
  createDefaultCheckers,
} from "./registry";
export { LEAN4_IMAGE_REF as DEFAULT_LEAN4_IMAGE } from "@crewhaus/sandbox-image-lean4";
export { Z3_IMAGE_REF as DEFAULT_SMT_IMAGE } from "@crewhaus/sandbox-image-z3";
