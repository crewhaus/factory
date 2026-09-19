/**
 * The two MACHINE-WIDE roots these tools read, and why neither is a caller
 * input.
 *
 * A fleet tool is about the harnesses on this machine, and the two files
 * that record them — `<registryRoot>/harnesses.json` and
 * `<hangarRoot>/jobs.jsonl` — live outside any workspace on purpose: the
 * registry is what makes a harness visible to a manager started from
 * somewhere else entirely. Containing them to `process.cwd()` would mean
 * these tools could never see the real registry; taking them as a caller
 * argument would mean a caller could aim a 0600 write anywhere on the disk.
 *
 * So they are resolved from the ENVIRONMENT, by the same functions the CLI
 * and the manager resolve them with, and no input field can move them. The
 * tools report the absolute path they used, so a reader always knows which
 * file an answer came from. Every path a CALLER supplies — a harness
 * directory, a settings file — still goes through `resolveSafe` and stays
 * inside the workspace.
 */
import { join, resolve } from "node:path";
import { REGISTRY_FILENAME, resolveRegistryRoot } from "@crewhaus/harness-registry";

/** `<registryRoot>/harnesses.json` — the file `openHangarRegistry` opens. */
export function registryFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(resolveRegistryRoot(env), REGISTRY_FILENAME);
}

/**
 * The hangar root: `CREWHAUS_HANGAR_ROOT`, else `<registryRoot>/hangar`.
 *
 * MIRRORED, not imported. `resolveHangarRoot` lives in
 * `apps/cli/src/hangar-cmd.ts` and a package cannot depend on the app — the
 * same reason `harness-supervisor/src/bundle-freshness.ts` mirrors the
 * bundle manifest shape instead of importing it. The second half of the rule
 * is not re-derived: `resolveRegistryRoot` is the registry package's own.
 * `roots.test.ts` pins both halves, so a change in the app fails a test here
 * rather than silently pointing this tool at a ledger nobody writes.
 */
export function resolveHangarRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env["CREWHAUS_HANGAR_ROOT"];
  // `resolve`, like the app's copy: a relative CREWHAUS_HANGAR_ROOT must
  // become the same absolute path the manager opened, not one relative to
  // whatever directory this tool happens to run in.
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  return join(resolveRegistryRoot(env), "hangar");
}

/** The durable job ledger the manager appends to. */
export const JOB_LEDGER_FILENAME = "jobs.jsonl";

/** `<hangarRoot>/jobs.jsonl` — the path `createFileJobStore` is opened on. */
export function jobLedgerPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(resolveHangarRoot(env), JOB_LEDGER_FILENAME);
}
