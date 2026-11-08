/**
 * Where the access records live, so no caller spells a path. Every path is relative to
 * the Hangar root, which is the containment root of every read and write here.
 */
import { join } from "node:path";
import type { Ledger } from "@crewhaus/control-records";

export const ACCESS_DIR = "access";

/** The ledgers, one per kind; each is one file that never rolls. */
export const LEDGER_KINDS = [
  "principals",
  "grants",
  "credentials",
  "invites",
  "links",
  "governed",
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

export type AccessPaths = {
  readonly dir: string;
  readonly lock: string;
  readonly claims: string;
  readonly revision: string;
  readonly subjects: string;
  readonly subjectKey: string;
  /** The bootstrap token Home mints, beside `access/`, never inside it. */
  readonly token: string;
  readonly ledgers: Readonly<Record<LedgerKind, string>>;
};

/** The fixed names, relative to the Hangar root. Pure: touches no file. */
export function accessPaths(): AccessPaths {
  const ledgers = Object.fromEntries(
    LEDGER_KINDS.map((kind) => [kind, join(ACCESS_DIR, `${kind}.jsonl`)]),
  ) as Record<LedgerKind, string>;
  return {
    dir: ACCESS_DIR,
    lock: join(ACCESS_DIR, "lock"),
    claims: join(ACCESS_DIR, "claims"),
    revision: join(ACCESS_DIR, "revision.json"),
    subjects: join(ACCESS_DIR, "subjects.json"),
    subjectKey: join(ACCESS_DIR, "keys", "subject.key"),
    token: "token",
    ledgers,
  };
}

/** One ledger per kind, all on the one access lock and claims directory. */
export function accessLedger(hangarRoot: string, kind: LedgerKind): Ledger {
  const paths = accessPaths();
  return {
    root: hangarRoot,
    records: { file: paths.ledgers[kind] },
    lock: paths.lock,
    claims: paths.claims,
  };
}

/** The claim that settles how an invite ends, once: consumed or revoked. */
export function inviteEndClaim(inviteId: string): string {
  return `invite/${inviteId}`;
}
