/**
 * Tolerant `.env` handling — re-exported. The server reads a harness's env
 * file(s) for two purposes only: (1) building the MERGED environment a spawn
 * from that harness dir would receive — the harness chain UNDER the process
 * env, the precedence `buildSpawnPlan` uses, which preflight checks run
 * against — and (2) reporting KEY presence booleans. Raw values never leave
 * the server — no route serializes them, and the masking tests enforce that
 * byte-level.
 *
 * The merge (`mergedSpawnEnv`, `readHarnessEnvFiles`) moved to
 * `@crewhaus/harness-supervisor`, beside `buildSpawnEnv` and `loadEnvChain`,
 * so `crewhaus daemon` reaches it without depending on this HTTP server.
 * This module re-exports every name it used to export, as the same bindings,
 * for one release; import from `@crewhaus/harness-supervisor` instead.
 *
 * `parseEnvText` was already the supervisor's parser, re-exported rather
 * than reimplemented. It used to be a verbatim copy, and the copy is exactly
 * what let a bug live in two places: both readers stripped surrounding
 * quotes without reversing the `\\`/`\"` escapes the writer emits, so a
 * value containing either came back altered. Worse than the bug itself, a
 * second reader can disagree with the one that builds the spawn environment
 * — the server would report one value and the child would receive another.
 * One implementation makes that class of drift impossible.
 */
export {
  mergedSpawnEnv,
  parseEnvText,
  readHarnessEnvFiles,
  type HarnessEnvFiles,
} from "@crewhaus/harness-supervisor";
