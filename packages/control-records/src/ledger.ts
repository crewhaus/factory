/**
 * The claim-and-ledger primitive. A claim file, created exclusively, DECIDES an
 * exactly-once fact. The ledger lock only orders appends and the fold a
 * compare-and-set reads first: the shared lock policy steals any lock older than 30
 * seconds, so a writer paused across a laptop sleep can wake to find another inside.
 * A claim carries what its record needs, so a crash between claim and append is
 * repaired on the next touch.
 *
 * That repair can race a slow but live winner, which is what a stolen lock creates,
 * so a claim's record can land twice. Every fold counts one record per claim and id,
 * the first line, and only the caller answered `won: true` may perform the effect. A
 * repair copies its record whole, so its duplicate shares both; a name an expired claim
 * gave up and a new record claimed again, with a new id, is a new object.
 *
 * A refused publish or append answers tool-safety's `SafeFsFailure`. A lock that cannot
 * be taken rejects with `withFileLock`'s own error, its message intact; anything but a
 * regular file at the lock's name is refused before the lock is created, in the same words.
 */
import { closeSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { MACHINES, canTransition } from "@crewhaus/control-contract";
import type { AcquireFileLockOptions } from "@crewhaus/infra-utils";
import {
  type SafeFsFailure,
  appendContained,
  ensureDirContained,
  resolveContained,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import {
  decodeStrict,
  ioFailure,
  openRecordFd,
  parseObject,
  readAt,
  readRecordFile,
  refusal,
  withControlLock,
} from "./io";
import { classifyLine, scanForward } from "./lines";
import type { Ledger } from "./paths";
import { appendTarget, readWatermark, retainedSegments, segmentRel } from "./segments";

/** What a ledger line holds. */
export type LedgerRecord = Readonly<Record<string, unknown>>;

/** A line of this many bytes or more, its `\n` counted, is refused by {@link append}. */
const MAX_ROW_BYTES = 4096;
/** A claim this large is refused at publish, so every published claim can be read back. */
const MAX_CLAIM_BYTES = 1024 * 1024;

type Hook = () => void | Promise<void>;

type LedgerSeams = {
  /** Passed through to `withFileLock`: a negative `staleMs` makes the steal immediate. */
  readonly lockOptions?: AcquireFileLockOptions;
  readonly afterLock?: Hook;
  /** In `casAppend`, between its fold and its claim. */
  readonly afterFold?: Hook;
  /** After the claim is published, before the append. */
  readonly afterClaim?: Hook;
  readonly now?: () => number;
};

let seams: LedgerSeams = {};

/**
 * Test seam: force an interleaving. Each call reads the seams once, when it starts, so
 * two concurrent writers can be held differently. Pass `undefined` to restore.
 */
export function _setLedgerSeamsForTest(next: LedgerSeams | undefined): void {
  seams = next ?? {};
}

/** The current time for a record's `at`. */
export function stamp(): string {
  return new Date(seams.now?.() ?? Date.now()).toISOString();
}

export type AppendAnswer = { readonly ok: true; readonly seg: number } | SafeFsFailure;

/**
 * One line, one `O_APPEND` write, no lock and no read: small enough to land whole, so
 * a run row costs nothing on the agent loop's path. A line of 4,096 bytes or more is
 * refused with `too-large`, appending nothing.
 *
 * First consumer: the run rows runtime-core writes (#507).
 */
export function append(ledger: Ledger, record: LedgerRecord): AppendAnswer {
  const line = `${JSON.stringify(record)}\n`;
  const size = Buffer.byteLength(line);
  if (size >= MAX_ROW_BYTES) {
    return refusal(
      "too-large",
      "file" in ledger.records ? ledger.records.file : ledger.records.dir,
      `a row of ${size} bytes is not under the ${MAX_ROW_BYTES}-byte bound; nothing was appended`,
    );
  }
  const target = appendTarget(ledger);
  if (!target.ok) return target;
  const written = appendContained(ledger.root, target.rel, line, {
    mode: 0o600,
    hardLinks: "refuse",
  });
  return written.ok ? { ok: true, seg: target.seg } : written;
}

/** The record's last byte is `\n`; `undefined` when the file cannot say (the append will). */
function endsInNewline(ledger: Ledger, rel: string): boolean | undefined {
  const opened = openRecordFd(ledger.root, rel);
  if (!opened.ok) return undefined;
  try {
    if (opened.stats.size === 0) return true;
    const last = Buffer.allocUnsafe(1);
    if (readAt(opened.fd, last, 1, opened.stats.size - 1) !== 1) return undefined;
    return last[0] === 0x0a;
  } catch {
    return undefined;
  } finally {
    closeSync(opened.fd);
  }
}

/** The append a lock holder uses: a crash-torn final line becomes a gap, not a swallowed record. */
export type LockedAppend = (record: LedgerRecord) => AppendAnswer;

function lockedAppendFor(ledger: Ledger): LockedAppend {
  return (record) => {
    const target = appendTarget(ledger);
    if (!target.ok) return target;
    const seal = endsInNewline(ledger, target.rel) === false ? "\n" : "";
    const written = appendContained(ledger.root, target.rel, `${seal}${JSON.stringify(record)}\n`, {
      mode: 0o600,
      hardLinks: "refuse",
    });
    return written.ok ? { ok: true, seg: target.seg } : written;
  };
}

/**
 * Run `fn` under the ledger's lock, for a fold-then-append sequence. `fn` receives a
 * locked append that first seals a torn final line. A refused lock directory answers
 * its `SafeFsFailure`; a lock that cannot be taken rejects.
 *
 * First consumers: the run ledger and the receipts.
 */
export async function withLedgerLock<T>(
  ledger: Ledger,
  fn: (lockedAppend: LockedAppend) => Promise<T> | T,
): Promise<T | SafeFsFailure> {
  const seam = seams;
  const dir = ensureDirContained(ledger.root, dirname(ledger.lock), { mode: 0o700 });
  if (!dir.ok) return dir;
  return withControlLock(
    join(dir.real, basename(ledger.lock)),
    async () => {
      await seam.afterLock?.();
      return fn(lockedAppendFor(ledger));
    },
    seam.lockOptions,
  );
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** What a claim file holds. `seg` is where its record belongs, so a repair knows where to look. */
export type ClaimContent = {
  readonly v: 1;
  readonly claim: string;
  readonly at: string;
  readonly seg: number;
  readonly record: LedgerRecord;
};

const CLAIM_KIND_RE = /^[a-z][a-z0-9-]*$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const GENERATION_RE = /^[1-9][0-9]{0,15}$/;
const GENERATION_KIND = "gen";

/** `<kind>/<name>`, or `gen/<object>/<n>`, as a path under the ledger's claims directory. */
function claimRel(ledger: Ledger, claim: string): string | SafeFsFailure {
  const parts = typeof claim === "string" ? claim.split("/") : [];
  const [kind, name, generation] = parts;
  const shaped =
    kind !== undefined &&
    name !== undefined &&
    CLAIM_KIND_RE.test(kind) &&
    SAFE_SEGMENT_RE.test(name) &&
    (kind === GENERATION_KIND
      ? parts.length === 3 && generation !== undefined && GENERATION_RE.test(generation)
      : parts.length === 2);
  if (!shaped) {
    return refusal(
      "invalid-path",
      String(claim),
      `${JSON.stringify(claim)} is not a claim: it is <kind>/<name>, or gen/<object>/<n>`,
    );
  }
  return generation === undefined
    ? join(ledger.claims, kind, `${name}.json`)
    : join(ledger.claims, kind, name, `${generation}.json`);
}

export type PublishAnswer = { readonly ok: true; readonly content: ClaimContent } | SafeFsFailure;

/**
 * Publish a claim file whole, or answer `code: "exists"` when another writer got there
 * first. The exclusive publish is the decision.
 *
 * First consumer: session-store's `decide`, which appends to two files under its own lock.
 */
export function publishClaim(ledger: Ledger, claim: string, record: LedgerRecord): PublishAnswer {
  const rel = claimRel(ledger, claim);
  if (typeof rel !== "string") return rel;
  const target = appendTarget(ledger);
  if (!target.ok) return target;
  const content: ClaimContent = { v: 1, claim, at: stamp(), seg: target.seg, record };
  const text = `${JSON.stringify(content)}\n`;
  if (Buffer.byteLength(text) > MAX_CLAIM_BYTES) {
    return refusal("too-large", rel, `claim ${JSON.stringify(claim)} is too large to publish`);
  }
  const dir = ensureDirContained(ledger.root, dirname(rel), { mode: 0o700 });
  if (!dir.ok) return dir;
  const written = writeFileSafe(ledger.root, rel, text, { overwrite: false, mode: 0o600 });
  return written.ok ? { ok: true, content } : written;
}

/**
 * Read a claim back, or refuse. A claim file that does not hold a claim is refused,
 * because a repair must never be built from it.
 *
 * First consumer: session-store's `decide`.
 */
export function readClaim(ledger: Ledger, claim: string): PublishAnswer {
  const rel = claimRel(ledger, claim);
  if (typeof rel !== "string") return rel;
  const read = readRecordFile(ledger.root, rel, MAX_CLAIM_BYTES);
  if (!read.ok) return read;
  const text = read.truncated ? undefined : decodeStrict(read.bytes);
  const body = text === undefined ? undefined : parseObject(text);
  const record = body?.["record"];
  const seg = body?.["seg"];
  if (
    body?.["v"] !== 1 ||
    body["claim"] !== claim ||
    typeof body["at"] !== "string" ||
    !Number.isSafeInteger(seg) ||
    typeof record !== "object" ||
    record === null ||
    Array.isArray(record)
  ) {
    return refusal("io-error", rel, `claim ${JSON.stringify(claim)} is not a readable claim file`);
  }
  return {
    ok: true,
    content: { v: 1, claim, at: body["at"], seg: seg as number, record: record as LedgerRecord },
  };
}

/**
 * Which fact a line records: its claim and its id. A row without a string `id` is keyed by
 * its claim alone.
 */
function factOf(claim: string, id: unknown): string {
  return typeof id === "string" ? JSON.stringify([claim, id]) : JSON.stringify([claim]);
}

/** Whether a line carrying this claim and id exists from segment `from` onward. */
function claimHasLine(
  ledger: Ledger,
  claim: string,
  id: unknown,
  from: number,
): boolean | SafeFsFailure {
  const fact = factOf(claim, id);
  const retained = retainedSegments(ledger);
  if (!retained.ok) return retained;
  for (const seg of retained.segs) {
    if (seg < from) continue;
    const rel = segmentRel(ledger.records, seg);
    const opened = openRecordFd(ledger.root, rel);
    if (!opened.ok) {
      if (opened.code === "not-found") continue;
      return opened;
    }
    let found = false;
    try {
      scanForward(opened.fd, 0, opened.stats.size, Number.POSITIVE_INFINITY, (line) => {
        const value = classifyLine(line);
        found =
          value.kind === "record" &&
          value.record["claim"] === claim &&
          factOf(claim, value.record["id"]) === fact;
        return found ? "stop-after" : "go";
      });
    } catch (err) {
      return ioFailure(rel, err, "read");
    } finally {
      closeSync(opened.fd);
    }
    if (found) return true;
  }
  return false;
}

/**
 * The loser's half: complete a winner that died between its claim and its append.
 * A claim below the watermark is never repaired: its record went with its segment, and
 * generation claims outlive segments, so a repair there would resurrect a retired record.
 */
function repairClaim(
  ledger: Ledger,
  winner: ClaimContent,
  lockedAppend: LockedAppend,
): { readonly repaired: boolean } | SafeFsFailure {
  const mark = readWatermark(ledger);
  if (!mark.ok) return mark;
  if (winner.seg < mark.seg) return { repaired: false };
  const has = claimHasLine(ledger, winner.claim, winner.record["id"], winner.seg);
  if (typeof has !== "boolean") return has;
  if (has) return { repaired: false };
  const written = lockedAppend({ ...winner.record, claim: winner.claim, repaired: true });
  return written.ok ? { repaired: true } : written;
}

export type AppendClaimAnswer =
  | { readonly ok: true; readonly won: true; readonly seg: number }
  | {
      readonly ok: true;
      readonly won: false;
      readonly winner: ClaimContent;
      /** This call completed the winner's append. */
      readonly repaired?: true;
    }
  | SafeFsFailure;

/**
 * Decide an exactly-once fact and record it. Only the caller answered `won: true` may
 * perform the effect; a repair appends the record but never earns that.
 *
 * First consumers: decisions, idempotency and receipts.
 */
export async function appendClaim(
  ledger: Ledger,
  input: { readonly claim: string; readonly record: LedgerRecord },
): Promise<AppendClaimAnswer> {
  const seam = seams;
  const { claim, record } = input;
  return withLedgerLock<AppendClaimAnswer>(ledger, async (lockedAppend) => {
    const published = publishClaim(ledger, claim, record);
    if (!published.ok) {
      if (published.code !== "exists") return published;
      const winner = readClaim(ledger, claim);
      if (!winner.ok) return winner;
      const repair = repairClaim(ledger, winner.content, lockedAppend);
      if ("ok" in repair) return repair;
      return {
        ok: true,
        won: false,
        winner: winner.content,
        ...(repair.repaired ? { repaired: true as const } : {}),
      };
    }
    await seam.afterClaim?.();
    const written = lockedAppend({ ...record, claim });
    return written.ok ? { ok: true, won: true, seg: written.seg } : written;
  });
}

/** At most this many names come back from {@link listClaims}; the rest are reported cut. */
const LIST_CLAIMS_CAP = 10_000;

export type ClaimList =
  | {
      readonly ok: true;
      /** `<kind>/<name>`, sorted. */
      readonly names: readonly string[];
      /** True when the directory held more than the cap. */
      readonly truncated: boolean;
    }
  | SafeFsFailure;

/**
 * The claims of one kind in a ledger, as `<kind>/<name>`: a read, which writes nothing and
 * takes no lock. A kind that is not a claim kind (or is `gen`, whose claims are per
 * object), and a kind directory that resolves outside the ledger's claims directory, are
 * refused. A missing directory has none. Names that are not claim names are skipped, and
 * at most `cap` come back, with `truncated` saying when more were there.
 *
 * First consumer: control-service's idempotency-claim expiry sweep.
 */
export function listClaims(
  ledger: Ledger,
  kind: string,
  options: { readonly cap?: number } = {},
): ClaimList {
  if (typeof kind !== "string" || !CLAIM_KIND_RE.test(kind) || kind === GENERATION_KIND) {
    return refusal("invalid-path", String(kind), `${JSON.stringify(kind)} is not a claim kind`);
  }
  const rel = join(ledger.claims, kind);
  const claimsDir = resolveContained(ledger.root, ledger.claims);
  if (!claimsDir.ok) {
    return claimsDir.code === "not-found" ? { ok: true, names: [], truncated: false } : claimsDir;
  }
  const at = resolveContained(ledger.root, rel);
  if (!at.ok) return at.code === "not-found" ? { ok: true, names: [], truncated: false } : at;
  const inside = relative(claimsDir.real, at.real);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    return refusal("escapes-root", rel, `${JSON.stringify(rel)} is not inside the ledger's claims`);
  }
  let entries: readonly string[];
  try {
    entries = readdirSync(at.real);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT")
      return { ok: true, names: [], truncated: false };
    return ioFailure(rel, err, "listed");
  }
  const cap = options.cap ?? LIST_CLAIMS_CAP;
  const names: string[] = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    if (!SAFE_SEGMENT_RE.test(name)) continue;
    names.push(`${kind}/${name}`);
  }
  return names.length > cap
    ? { ok: true, names: names.slice(0, cap), truncated: true }
    : { ok: true, names, truncated: false };
}

export type ExpireAnswer = { readonly ok: true; readonly removed: boolean } | SafeFsFailure;

/**
 * Remove a claim whose `at` is older than `notBefore` (epoch ms), so its name can be claimed
 * again. Under the ledger lock the claim is read again and removed only while it is still
 * that old; a younger claim, a missing one and one whose `at` cannot be read are left
 * alone. A generation claim is never removed and is refused. The removal is contained: a
 * link planted at the claim's name is removed, never followed.
 *
 * First consumer: idempotency keys, honoured for seven days.
 */
export async function expireClaim(
  ledger: Ledger,
  claim: string,
  notBefore: number,
): Promise<ExpireAnswer> {
  const rel = claimRel(ledger, claim);
  if (typeof rel !== "string") return rel;
  if (claim.split("/")[0] === GENERATION_KIND) {
    return refusal(
      "invalid-path",
      rel,
      `${JSON.stringify(claim)} is a generation claim: never removed`,
    );
  }
  return withLedgerLock<ExpireAnswer>(ledger, () => {
    const read = readClaim(ledger, claim);
    if (!read.ok) return read.code === "not-found" ? { ok: true, removed: false } : read;
    const at = Date.parse(read.content.at);
    if (!Number.isFinite(at) || at >= notBefore) return { ok: true, removed: false };
    const resolved = resolveContained(ledger.root, rel, { followLeaf: false });
    if (!resolved.ok) return resolved;
    try {
      unlinkSync(resolved.real);
    } catch (err) {
      return ioFailure(rel, err, "remove");
    }
    return { ok: true, removed: true };
  });
}

// ---------------------------------------------------------------------------
// Folds
// ---------------------------------------------------------------------------

/** An object's current state: its last row a fold applied. */
export type FoldedObject = {
  readonly id: string;
  readonly state: string | undefined;
  readonly record: LedgerRecord;
};

/** A row a machine refuses. It stays on disk and is shown; it is never applied. */
export type FoldAnomaly = {
  readonly id: string;
  /** `null` when the object had no applied row yet. */
  readonly from: string | null;
  /** `null` when the row has no string `state`. */
  readonly to: string | null;
  readonly at: { readonly seg: number; readonly off: number };
};

export type FoldGap = {
  readonly seg: number;
  readonly off: number;
  readonly bytes: number;
  readonly reason: "unreadable";
};

export type FoldAnswer =
  | {
      readonly ok: true;
      readonly objects: ReadonlyMap<string, FoldedObject>;
      /** The highest generation seen per id, on any row, applied or not. */
      readonly generations: ReadonlyMap<string, number>;
      /** Facts counted: lines that parsed, one per claim and id. */
      readonly records: number;
      readonly anomalies: readonly FoldAnomaly[];
      readonly gaps: readonly FoldGap[];
    }
  | SafeFsFailure;

/** Whether this row may apply to an object in this state, by the ledger's machine. */
function rowIsLegal(ledger: Ledger, from: string | undefined, to: unknown): boolean {
  if (ledger.machine === undefined) return true;
  if (typeof to !== "string") return false;
  return from === undefined
    ? MACHINES[ledger.machine].entry.includes(to)
    : canTransition(ledger.machine, from, to);
}

/**
 * Every retained segment, read whole, folded by `id` through the ledger's machine, one
 * record per claim and id (the first line; a row without a string `id` by its claim
 * alone). It is uncapped because a fold decides writes: a capped read is only a view, and
 * a list uses `readPage`. A segment that cannot be read is refused rather than folded
 * around.
 *
 * First consumers: the run ledger and the receipts.
 */
export function foldStates(ledger: Ledger): FoldAnswer {
  const retained = retainedSegments(ledger);
  if (!retained.ok) return retained;
  const objects = new Map<string, FoldedObject>();
  const generations = new Map<string, number>();
  const claims = new Set<string>();
  const anomalies: FoldAnomaly[] = [];
  const gaps: FoldGap[] = [];
  let records = 0;
  for (const seg of retained.segs) {
    const rel = segmentRel(ledger.records, seg);
    const opened = openRecordFd(ledger.root, rel);
    if (!opened.ok) {
      if (opened.code === "not-found") continue;
      return opened;
    }
    try {
      scanForward(opened.fd, 0, opened.stats.size, Number.POSITIVE_INFINITY, (line) => {
        const value = classifyLine(line);
        if (value.kind === "malformed") {
          gaps.push({ seg, off: line.off, bytes: line.bytes, reason: "unreadable" });
        }
        if (value.kind !== "record") return "go";
        const row = value.record;
        const claim = row["claim"];
        if (typeof claim === "string") {
          const fact = factOf(claim, row["id"]);
          if (claims.has(fact)) return "go";
          claims.add(fact);
        }
        records += 1;
        const id = row["id"];
        if (typeof id !== "string") return "go";
        const gen = row["gen"];
        if (Number.isSafeInteger(gen) && (gen as number) > (generations.get(id) ?? 0)) {
          generations.set(id, gen as number);
        }
        const current = objects.get(id);
        const state = row["state"];
        if (rowIsLegal(ledger, current?.state, state)) {
          objects.set(id, {
            id,
            state: typeof state === "string" ? state : undefined,
            record: row,
          });
        } else {
          anomalies.push({
            id,
            from: current?.state ?? null,
            to: typeof state === "string" ? state : null,
            at: { seg, off: line.off },
          });
        }
        return "go";
      });
    } catch (err) {
      return ioFailure(rel, err, "read");
    } finally {
      closeSync(opened.fd);
    }
  }
  return { ok: true, objects, generations, records, anomalies, gaps };
}

export type CasAnswer =
  | {
      readonly ok: true;
      readonly applied: true;
      readonly gen: number;
      readonly seg: number;
      readonly record: LedgerRecord;
    }
  | {
      readonly ok: true;
      readonly applied: false;
      /** The object's current record; `null` when it is absent. */
      readonly current: LedgerRecord | null;
      /** The object was in the expected state, and the machine refuses the move. */
      readonly illegal?: true;
      /** The objects the precondition names are not as the caller read them. */
      readonly precondition?: "changed";
    }
  | SafeFsFailure;

/**
 * What a compare-and-set also requires of the rest of the ledger: the objects in state
 * `inState` are exactly `exactly`, each at its listed generation, none added and none
 * missing. A row written without `gen` folds to generation 0.
 */
export type CasPrecondition = {
  readonly inState: string;
  readonly exactly: readonly { readonly id: string; readonly gen: number }[];
};

/** Whether the fold holds exactly the objects a precondition lists, at their generations. */
function preconditionHolds(
  fold: Extract<FoldAnswer, { ok: true }>,
  precondition: CasPrecondition,
): boolean {
  const listed = new Map<string, number>();
  for (const { id, gen } of precondition.exactly) {
    if (listed.has(id)) return false;
    listed.set(id, gen);
  }
  let found = 0;
  for (const object of fold.objects.values()) {
    if (object.state !== precondition.inState) continue;
    const gen = listed.get(object.id);
    if (gen === undefined || (fold.generations.get(object.id) ?? 0) !== gen) return false;
    found += 1;
  }
  return found === listed.size;
}

/**
 * Compare-and-set. Under the lock: fold the object; a state other than `expectState`
 * (`null` means absent) answers `current`; a move the machine refuses answers `illegal`.
 * With a `precondition`, the same fold must also hold exactly the objects it lists in its
 * state, at their generations, or the answer is `precondition: "changed"` with nothing
 * claimed or appended: a caller that decided from an earlier read acts only on the ledger
 * it read. Otherwise publish generation claim `gen/<id>/<g+1>`, which is what decides, and
 * append `{...next, id, gen}`. A lost claim answers the winner's record, after repairing
 * it. Generation claims are never removed. They are keyed by `id` alone, so ledgers that
 * share a claims directory must not reuse an id.
 *
 * First consumers: activation, `dec_` decisions and attention overlays.
 */
export async function casAppend(
  ledger: Ledger,
  id: string,
  expectState: string | null,
  next: LedgerRecord,
  precondition?: CasPrecondition,
): Promise<CasAnswer> {
  const seam = seams;
  return withLedgerLock<CasAnswer>(ledger, (lockedAppend) =>
    casUnderLock(ledger, lockedAppend, seam, id, expectState, next, precondition),
  );
}

/**
 * {@link casAppend} for a caller that already holds the lock `ledger.lock` names, taken
 * through {@link withLedgerLock} on this ledger or on another that shares the lock (every
 * `harnessLedger` does). One lock can then cover a compare-and-set on two ledgers and a
 * write beside them. Calling it without the lock is a caller's bug: nothing here takes it.
 *
 * First consumers: standing rules and the requests that ask an owner for one.
 */
export async function casAppendLocked(
  ledger: Ledger,
  id: string,
  expectState: string | null,
  next: LedgerRecord,
  precondition?: CasPrecondition,
): Promise<CasAnswer> {
  return casUnderLock(ledger, lockedAppendFor(ledger), seams, id, expectState, next, precondition);
}

async function casUnderLock(
  ledger: Ledger,
  lockedAppend: LockedAppend,
  seam: LedgerSeams,
  id: string,
  expectState: string | null,
  next: LedgerRecord,
  precondition: CasPrecondition | undefined,
): Promise<CasAnswer> {
  const fold = foldStates(ledger);
  if (!fold.ok) return fold;
  const current = fold.objects.get(id);
  const holds = expectState === null ? current === undefined : current?.state === expectState;
  if (!holds) return { ok: true, applied: false, current: current?.record ?? null };
  if (!rowIsLegal(ledger, current?.state, next["state"])) {
    return { ok: true, applied: false, current: current?.record ?? null, illegal: true };
  }
  if (precondition !== undefined && !preconditionHolds(fold, precondition)) {
    return { ok: true, applied: false, current: current?.record ?? null, precondition: "changed" };
  }
  await seam.afterFold?.();
  const gen = (fold.generations.get(id) ?? 0) + 1;
  const claim = `${GENERATION_KIND}/${id}/${gen}`;
  const row: LedgerRecord = { ...next, id, gen, claim };
  const published = publishClaim(ledger, claim, row);
  if (!published.ok) {
    if (published.code !== "exists") return published;
    const winner = readClaim(ledger, claim);
    if (!winner.ok) return winner;
    const repair = repairClaim(ledger, winner.content, lockedAppend);
    if ("ok" in repair) return repair;
    return { ok: true, applied: false, current: winner.content.record };
  }
  await seam.afterClaim?.();
  const written = lockedAppend(row);
  if (!written.ok) return written;
  return { ok: true, applied: true, gen, seg: written.seg, record: row };
}
