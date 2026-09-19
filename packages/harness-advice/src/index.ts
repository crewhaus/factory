/**
 * `@crewhaus/harness-advice` — the deterministic advice modules, lifted out of
 * `apps/cli/src` so a `packages/tool-*` can reach them: a package may not
 * depend on an app, and that is what kept these out of tool reach.
 *
 * See README.md for what each module answers.
 */
export * from "./advise-rules";
export * from "./doctor-checks";
export * from "./doctor-fix";
export * from "./permissions-suggest";
export * from "./shadow-lane";
