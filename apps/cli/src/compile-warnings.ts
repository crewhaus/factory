/**
 * Compile warning codes that print but never fail `crewhaus compile --strict`.
 * The list moved to `@crewhaus/compile-service`, whose `checkSpec` marks each
 * warning informational or not from it; this path re-exports it, so the
 * `--strict` filter and the `compile --help` text keep reading the same list.
 */
export { INFORMATIONAL_COMPILE_WARNING_CODES, wrapCodes } from "@crewhaus/compile-service";
