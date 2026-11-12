/**
 * Where receipts live. A harness's commands are in the harness
 * (`.crewhaus/run/control/commands/`), on its shared lock and claims, so the CLI and Home
 * write one ledger. A command about Home itself, or about a harness whose directory is
 * gone, lands in Home's own (`<hangarRoot>/control/commands/`).
 */
import { join } from "node:path";
import {
  type DigestKeyRead,
  type Ledger,
  controlPaths,
  ensureDigestKey,
  harnessLedger,
} from "@crewhaus/control-records";

/** Which ledger a command is written to. */
export type LedgerChoice = { readonly harness: string } | "workspace";

/** A harness's command ledger. What both heads and every test read receipts through. */
export function commandsLedgerOf(harnessDir: string): Ledger {
  return harnessLedger(
    harnessDir,
    { dir: join(controlPaths(harnessDir).controlDir, "commands") },
    { machine: "command" },
  );
}

/** The digest key's file under the Hangar root, relative to it. */
export const WORKSPACE_DIGEST_KEY_FILE = join("control", "keys", "digest.key");

/** Home's own command ledger, under the Hangar root. */
export function workspaceCommandsLedger(hangarRoot: string): Ledger {
  return {
    root: hangarRoot,
    records: { dir: join("control", "commands") },
    lock: join("control", "lock"),
    claims: join("control", "claims"),
    machine: "command",
  };
}

export function ledgerFor(choice: LedgerChoice, hangarRoot: string): Ledger {
  return choice === "workspace"
    ? workspaceCommandsLedger(hangarRoot)
    : commandsLedgerOf(choice.harness);
}

/** The key the ledger's digests are made under: the harness's own, or Home's. */
export function ensureLedgerKey(
  choice: LedgerChoice,
  hangarRoot: string,
): Promise<Exclude<DigestKeyRead, { readonly state: "absent" }>> {
  return choice === "workspace"
    ? ensureDigestKey(hangarRoot, { file: WORKSPACE_DIGEST_KEY_FILE })
    : ensureDigestKey(choice.harness);
}
