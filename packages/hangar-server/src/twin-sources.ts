/**
 * The sources of the command-line equivalents Home shows that the package root
 * does not export, gathered for the test that checks every one of them
 * against the CLI's verb inventory (`apps/cli/src/cli-twins.test.ts`): the
 * advisor's job commands, the route table and its write notes, the runtime
 * operations' command builder with the two argv builders it is called with,
 * and the fact-store size cap the memory sweep seeds past.
 *
 * Re-exports only.
 */
export { ADVISOR_CLI_TWINS } from "./advisor";
export { MAX_FACT_FILE_BYTES } from "./constants";
export { ROUTE_TABLE } from "./route-table";
export { ROUTE_TWIN_NOTES } from "./route-twin-notes";
export { devArgv, mcpArgv, runtimeOpTwin } from "./runtime-ops";
