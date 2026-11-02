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
import { join } from "node:path";
import {
  REGISTRY_FILENAME,
  resolveHangarRoot,
  resolveRegistryRoot,
} from "@crewhaus/harness-registry";

/** `<registryRoot>/harnesses.json` — the file `openHangarRegistry` opens. */
export function registryFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(resolveRegistryRoot(env), REGISTRY_FILENAME);
}

/**
 * The hangar root (`CREWHAUS_HANGAR_ROOT`, else `<registryRoot>/hangar`),
 * resolved by the registry package's own resolver, the one the CLI uses.
 */
export { resolveHangarRoot };

/** The durable job ledger the manager appends to. */
export const JOB_LEDGER_FILENAME = "jobs.jsonl";

/** `<hangarRoot>/jobs.jsonl` — the path `createFileJobStore` is opened on. */
export function jobLedgerPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(resolveHangarRoot(env), JOB_LEDGER_FILENAME);
}
