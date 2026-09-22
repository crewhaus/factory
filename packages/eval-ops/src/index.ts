/**
 * `@crewhaus/eval-ops` — what eval runs add up to, lifted out of
 * `apps/cli/src` so a `packages/tool-*` can reach them: a package may not
 * depend on an app, and that is what kept these out of tool reach.
 *
 * See README.md for what each module answers.
 */
export * from "./eval-coverage";
export * from "./eval-history";
export * from "./graders-test";
