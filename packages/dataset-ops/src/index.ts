/**
 * `@crewhaus/dataset-ops` — eval-dataset operations, lifted out of
 * `apps/cli/src` so a `packages/tool-*` can reach them: a package may not
 * depend on an app, and that is what kept these out of tool reach.
 *
 * See README.md for what each module answers.
 */
export * from "./dataset-audit";
export * from "./dataset-lint";
export * from "./dataset-mine";
export * from "./datasets";
export * from "./graders-suggest";
