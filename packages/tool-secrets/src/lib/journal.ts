/**
 * What was rotated, when — and the lock that keeps two rotations from racing.
 *
 * ── The journal ────────────────────────────────────────────────────────────
 *
 * A line per rotation: the reference, the backend, the timestamp, and the
 * fingerprints before and after. No values, ever — this file is as readable as
 * any other file in the workspace, and a journal that carried plaintext would
 * be a secret store nobody declared.
 *
 * It exists for two answers: "when was this last rotated?" (which is the
 * question a rotation policy is made of) and the `minIntervalHours` guard.
 *
 * ── The lock ───────────────────────────────────────────────────────────────
 *
 * `minIntervalHours` is a read-then-act guard, and read-then-act with no
 * atomicity is not a guard at all: two calls arriving together both read the
 * old timestamp, both decide they are allowed, and both rotate. For a
 * credential that is worse than doing nothing — the second rotation
 * invalidates the value the first one just handed out, and whoever received it
 * is locked out with no way to tell why.
 *
 * So the whole rotation runs under an exclusively-created lock file
 * (`open(..., "wx")`, which is atomic on every filesystem this runs on). A
 * second caller is REFUSED, by name, rather than queued: a rotation that waits
 * for another rotation is a rotation nobody is watching.
 *
 * A lock left behind by a killed process would otherwise wedge rotation
 * forever, so one older than `LOCK_STALE_MS` is broken — and the breaking is
 * reported, because "I ignored somebody else's lock" is a fact the operator
 * should see rather than a detail this tool keeps to itself.
 *
 * Breaking a lock is only ever justified by a timestamp that says it is old.
 * A lock whose age cannot be established — empty, truncated, unparseable, or
 * carrying no `startedAt` — is of UNKNOWN age, and unknown is not stale: the
 * create below is `open(wx)` plus a separate `write`, so a concurrent caller
 * can catch a lock in its zero-byte moment, and "I could not read it, so I
 * took it" would let both rotations run.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSafe } from "../paths";
import { type Resolved, refuse } from "./refs";
import { SECRETS_DIR } from "./resolve";
import { writeFileAtomic } from "./write";

export const JOURNAL_PATH = join(SECRETS_DIR, "rotations.json");
export const LOCK_PATH = join(SECRETS_DIR, "rotation.lock");
/** A rotation that has held the lock this long is assumed dead. */
export const LOCK_STALE_MS = 10 * 60_000;

let clock: () => number = Date.now;

/**
 * Test seam. Every timestamp in this package comes from here, so no test has
 * to assert a wall-clock value — and the `minIntervalHours` guard can be
 * driven across days without one.
 */
export function _setClock(fn: (() => number) | undefined): void {
  clock = fn ?? Date.now;
}

export function now(): number {
  return clock();
}

export type JournalEntry = {
  readonly ref: string;
  readonly backend: string;
  readonly rotatedAt: string;
  readonly fingerprint: string;
  readonly previousFingerprint?: string;
};

type Journal = { readonly version: 1; readonly entries: readonly JournalEntry[] };

const EMPTY: Journal = { version: 1, entries: [] };

/**
 * Read the journal, tolerating every way it can be unreadable.
 *
 * A corrupt journal must not stop a rotation: the history is a convenience,
 * the credential is not. It is reported as unreadable and treated as empty,
 * which fails SAFE for the interval guard (an unknown last-rotation reads as
 * "not rotated recently"), so the caller can still rotate — deliberately —
 * while being told the record is gone.
 */
export function readJournal(toolName: string): {
  readonly journal: Journal;
  readonly unreadable?: string;
} {
  let real: string;
  try {
    real = resolveSafe(toolName, JOURNAL_PATH).real;
  } catch {
    return { journal: EMPTY, unreadable: "the journal path escapes the workspace root" };
  }
  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch (err) {
    // ENOENT is the ONLY failure that means "nothing has been rotated yet".
    // Every other one (EACCES, EISDIR, EIO) means the history could not be
    // READ, which is a different fact with the same shape — and returning an
    // empty journal for it silently switches `minIntervalHours` off: the guard
    // reports "no previous rotation recorded" and waves through a rotation it
    // was configured to refuse. An unknown reported as a definite answer is
    // this package's job to avoid, so it is named here instead.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { journal: EMPTY };
    return {
      journal: EMPTY,
      unreadable: `${JOURNAL_PATH} could not be read (${code ?? "unknown error"}), so no rotation history is available`,
    };
  }
  try {
    const parsed = JSON.parse(text) as Journal;
    if (!Array.isArray(parsed.entries)) throw new Error("no entries array");
    return { journal: { version: 1, entries: parsed.entries } };
  } catch {
    return { journal: EMPTY, unreadable: `${JOURNAL_PATH} is not readable as a rotation journal` };
  }
}

/** The most recent entry for a reference, by file order (append-only). */
export function lastRotation(
  entries: readonly JournalEntry[],
  ref: string,
): JournalEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.ref === ref) return entry;
  }
  return undefined;
}

/** How many entries are kept. Old rotations stop being interesting. */
const MAX_ENTRIES = 500;

export function appendJournal(toolName: string, entry: JournalEntry): void {
  const { journal } = readJournal(toolName);
  const entries = [...journal.entries, entry].slice(-MAX_ENTRIES);
  const real = resolveSafe(toolName, JOURNAL_PATH).real;
  writeFileAtomic(real, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

export type Lock = {
  readonly brokeStale?: string;
  release(): void;
};

/**
 * Take the rotation lock, or refuse.
 *
 * `wx` is the whole mechanism: the create either wins or fails with EEXIST,
 * atomically, with no window between checking and creating.
 */
export function acquireLock(toolName: string, ref: string): Resolved<Lock> {
  let real: string;
  try {
    mkdirSync(resolveSafe(toolName, SECRETS_DIR).real, { recursive: true, mode: 0o700 });
    real = resolveSafe(toolName, LOCK_PATH).real;
  } catch {
    return refuse(`${SECRETS_DIR} could not be prepared inside the workspace root.`);
  }

  const body = JSON.stringify({ ref, pid: process.pid, startedAt: now() });
  const take = (): Lock => ({
    release(): void {
      try {
        unlinkSync(real);
      } catch {
        // Already gone — another caller broke it as stale, which is reported
        // by that caller rather than thrown here at the end of a rotation
        // that otherwise succeeded.
      }
    },
  });

  try {
    writeFileSync(real, body, { mode: 0o600, flag: "wx" });
    return { ok: true, value: take() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return refuse(`the rotation lock could not be taken: ${(err as Error).message}`);
    }
  }

  let held: { ref?: string; startedAt?: number };
  try {
    held = JSON.parse(readFileSync(real, "utf8")) as { ref?: string; startedAt?: number };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // The holder released it between our EEXIST and this read. The lock is
      // genuinely free, so the atomic create is simply retried — this is the
      // one case where "the body could not be read" really is an empty lock.
      try {
        writeFileSync(real, body, { mode: 0o600, flag: "wx" });
        return { ok: true, value: take() };
      } catch (retry) {
        return refuse(`the rotation lock could not be taken: ${(retry as Error).message}`);
      }
    }
    // Anything else: the lock EXISTS and we cannot tell who holds it or when
    // they took it. Treating that as stale — which is what reading a missing
    // timestamp as 0 did — is the worst possible reading, because the create
    // in this function is `open(wx)` followed by a separate `write`: a
    // concurrent caller that looks in between sees a ZERO-BYTE lock, decides
    // it is ancient, takes it over, and both rotations run. That is precisely
    // the race the lock exists to stop, and its consequence is the one this
    // file opens by describing: the second rotation invalidates the credential
    // the first just handed out. Unknown is not stale, so this refuses.
    return refuse(
      `a rotation lock is present at ${LOCK_PATH} but could not be read (${(err as Error).message}), so there is no way to tell whether a rotation is running right now. Rotating on top of another rotation invalidates the value the first one distributed, so this stops rather than guess. Check that nothing is rotating and remove ${LOCK_PATH}.`,
    );
  }
  if (typeof held.startedAt !== "number" || !Number.isFinite(held.startedAt)) {
    // Same reasoning: a lock with no usable timestamp is a lock of unknown
    // age, not an old one.
    return refuse(
      `a rotation lock is present at ${LOCK_PATH} but records no start time, so its age — and whether the process holding it is still alive — cannot be determined. Check that nothing is rotating and remove ${LOCK_PATH}.`,
    );
  }
  const age = now() - held.startedAt;
  if (age < LOCK_STALE_MS) {
    return refuse(
      `another rotation is in progress (holding the lock for ${Math.round(age / 1000)}s, for ${held.ref ?? "an unrecorded reference"}). Rotating the same secret twice at once invalidates the value the first rotation just distributed, so this one stops here. Wait for it, or remove ${LOCK_PATH} if you are sure nothing is running.`,
    );
  }
  try {
    writeFileSync(real, body, { mode: 0o600, flag: "w" });
  } catch (err) {
    return refuse(`the stale rotation lock could not be replaced: ${(err as Error).message}`);
  }
  return {
    ok: true,
    value: {
      ...take(),
      brokeStale: `took over a rotation lock last touched ${Math.round(age / 60_000)} minutes ago (held for ${held.ref ?? "an unrecorded reference"}); the process that made it is assumed dead.`,
    },
  };
}
