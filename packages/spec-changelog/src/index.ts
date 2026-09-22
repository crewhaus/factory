/**
 * `@crewhaus/spec-changelog` — a spec's version history and the upgrade that
 * writes the next entry, lifted out of `apps/cli/src` so a `packages/tool-*`
 * can reach them: a package may not depend on an app, and that is what kept
 * these out of tool reach.
 *
 * See README.md for what each module answers.
 */
export * from "./spec-changelog";
export * from "./upgrade";
