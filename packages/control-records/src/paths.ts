/**
 * Where control records live, so no caller spells a path. Every primitive takes a
 * containment root plus record paths relative to it, so the same code serves a
 * harness, a session root and the Hangar root.
 */
import { join } from "node:path";
import type { MachineName } from "@crewhaus/control-contract";

/** A segment directory, or one file that never rolls. Relative to the root. */
export type RecordsAt = { readonly dir: string } | { readonly file: string };

/** What the cursor functions read: a ledger satisfies it. */
export type RecordSource = {
  readonly root: string;
  readonly records: RecordsAt;
};

/**
 * A log of control facts. `machine` is set only for an object on a
 * control-contract machine; an attention overlay has none and gets no transition
 * check. A record's lifecycle fields are its top-level `id` and `state`.
 */
export type Ledger = RecordSource & {
  /** The lock file that orders fold-then-append sequences, relative to the root. */
  readonly lock: string;
  /** The directory that holds this ledger's claims, relative to the root. */
  readonly claims: string;
  readonly machine?: MachineName;
};

export type ControlPaths = {
  /** The containment root: the harness directory, as given. */
  readonly root: string;
  readonly controlDir: string;
  readonly lockFile: string;
  readonly claimsDir: string;
  readonly digestKeyFile: string;
  readonly mutatingLeaseFile: string;
  readonly operatorFile: string;
  readonly approversFile: string;
  /** The deployment records: compile's `prepared` rows and activation's moves. */
  readonly deploymentsFile: string;
  /** The harness's portable identity, `{v, id, slug?, createdAt}`. */
  readonly harnessIdentityFile: string;
};

/**
 * The control directory's fixed names, relative to the harness directory. Pure:
 * it touches no file. Each store adds its own name when it arrives.
 *
 * First consumers: the run ledger and the receipts.
 */
export function controlPaths(harnessDir: string): ControlPaths {
  const controlDir = join(".crewhaus", "run", "control");
  return {
    root: harnessDir,
    controlDir,
    lockFile: join(controlDir, "lock"),
    claimsDir: join(controlDir, "claims"),
    digestKeyFile: join(controlDir, "keys", "digest.key"),
    mutatingLeaseFile: join(controlDir, "leases", "mutating.json"),
    operatorFile: join(controlDir, "operator.json"),
    approversFile: join(controlDir, "approvers.json"),
    deploymentsFile: join(controlDir, "deployments.jsonl"),
    harnessIdentityFile: join(controlDir, "harness.json"),
  };
}

/**
 * A ledger in a harness, on the shared lock and claims. `records` is relative to the
 * harness directory, like every record path, so it takes a name from `controlPaths`.
 *
 * First consumers: the run ledger and the receipts.
 */
export function harnessLedger(
  harnessDir: string,
  records: RecordsAt,
  options: { readonly machine?: MachineName } = {},
): Ledger {
  const paths = controlPaths(harnessDir);
  return {
    root: harnessDir,
    records,
    lock: paths.lockFile,
    claims: paths.claimsDir,
    ...(options.machine !== undefined ? { machine: options.machine } : {}),
  };
}
