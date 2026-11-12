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

/**
 * The sign-in records: browsers' device keys and their sessions. Kept out of
 * `LEDGER_KINDS` on purpose, so the authority snapshot (`loadAccessSnapshot`) never folds
 * them and appending one never moves the access revision: a sign-in changes nobody's
 * authority.
 */
export const SIGN_IN_KINDS = ["devices", "sessions"] as const;

export type SignInKind = (typeof SIGN_IN_KINDS)[number];

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
  /** `devices.jsonl` and `sessions.jsonl`. */
  readonly signIn: Readonly<Record<SignInKind, string>>;
  /** Content-free lines about proxy identity headers Home ignored. */
  readonly security: string;
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
    signIn: {
      devices: join(ACCESS_DIR, "devices.jsonl"),
      sessions: join(ACCESS_DIR, "sessions.jsonl"),
    },
    security: join(ACCESS_DIR, "security.jsonl"),
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

/** A sign-in ledger, on the same access lock and claims directory as the others. */
export function signInLedger(hangarRoot: string, kind: SignInKind): Ledger {
  const paths = accessPaths();
  return {
    root: hangarRoot,
    records: { file: paths.signIn[kind] },
    lock: paths.lock,
    claims: paths.claims,
  };
}

/** The claim that settles how an invite ends, once: consumed or revoked. */
export function inviteEndClaim(inviteId: string): string {
  return `invite/${inviteId}`;
}
