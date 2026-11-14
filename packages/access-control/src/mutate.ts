/**
 * The one way an access record changes. Under the access lock: load the snapshot, check
 * that the actor holds `home.access.manage`, plan the rows, check every row's size, rewrite
 * `subjects.json` when it changed, append the rows, move the access revision (above every
 * registered harness's approver file), and bring the governed harnesses' projections to the
 * new snapshot. Then release.
 *
 * The lock is control-records' `withFileLock`, which is not re-entrant, so a mutation that
 * touches several ledgers takes it once and writes each ledger's rows with `append` while
 * holding it; the held lock is what orders them. An invite's end is settled by a claim, so
 * a revocation and a redemption racing for it cannot both win.
 */
import { append, publishClaim, withLedgerLock } from "@crewhaus/control-records";
import { type AccessActor, type DomainChecker, authorize } from "./authorize";
import { type Subjects, sealTornLine, subjectsText, writeRevision, writeSubjects } from "./files";
import { type LedgerKind, accessLedger, accessPaths } from "./paths";
import {
  type AccessHarness,
  EMPTY_REPORT,
  type ProjectionReport,
  highestProjectionEpoch,
  writeApproverProjections,
} from "./projection";
import { lineBytes } from "./records";
import { type AccessSnapshot, type AccessSnapshotRead, loadAccessSnapshot } from "./snapshot";

/** A ledger line of this many bytes or more is refused before anything is written. */
export const MAX_ROW_BYTES = 4096;

export type RefusalCode =
  | "unreadable"
  | "not-set-up"
  | "not-authorized"
  | "invalid"
  | "not-found"
  | "conflict"
  | "lockout"
  | "home-owner"
  | "ended"
  | "too-large"
  | "io-error";

export type Refusal = {
  readonly ok: false;
  readonly code: RefusalCode;
  /** One sentence for the person who asked. It names no secret and no file content. */
  readonly reason: string;
};

export function refusal(code: RefusalCode, reason: string): Refusal {
  return { ok: false, code, reason };
}

export type AccessContext = {
  readonly root: string;
  readonly now: () => number;
  /** The registered harnesses the projection writer covers. */
  readonly harnesses: () => readonly AccessHarness[];
  readonly domains: ReadonlyMap<string, DomainChecker>;
};

export type PlannedRow = { readonly kind: LedgerKind; readonly row: Record<string, unknown> };

/**
 * A row whose append is decided by an exclusive claim. `taken` answers when the claim was
 * already made: a refusal of the whole change, or `"skip"` to leave this one row out.
 */
export type PlannedClaim = PlannedRow & {
  readonly claim: string;
  readonly taken: Refusal | "skip";
};

export type Change<T> = {
  readonly rows: readonly PlannedRow[];
  readonly claims?: readonly PlannedClaim[];
  /** The whole subjects file after the change, when it changes. */
  readonly subjects?: Subjects;
  readonly result: T;
};

export type Planning = {
  readonly snapshot: AccessSnapshot | undefined;
  readonly now: number;
  /** The time every row of this change carries. */
  readonly at: string;
  /** The stored actor every row of this change carries. */
  readonly by: string;
};

export type Done<T> = {
  readonly ok: true;
  readonly result: T;
  /** The access revision after the change. */
  readonly epoch: number;
  readonly projections: ProjectionReport;
};

export type MutationOptions = {
  /** Whether this change can move who may decide on a harness. */
  readonly projections: boolean;
  /** Set up runs before any principal exists, as the owner it creates. */
  readonly setup?: { readonly by: (snapshot: AccessSnapshot | undefined) => string };
  /**
   * A change a principal makes to what is its own (revoking its own token), or one a
   * member already allowed (a device sign-in's token): the plan checks whose it is, so
   * `home.access.manage` is not asked for. The actor must be an active principal.
   */
  readonly own?: true;
};

const HOME = { scope: "home" } as const;

function rowsOf(change: Change<unknown>, skipped: ReadonlySet<string> = new Set()): PlannedRow[] {
  return [
    ...(change.claims ?? [])
      .filter((claim) => !skipped.has(claim.claim))
      .map((claim) => ({
        kind: claim.kind,
        row: { ...claim.row, claim: claim.claim },
      })),
    ...change.rows,
  ];
}

function snapshotOf(read: AccessSnapshotRead): AccessSnapshot | Refusal | undefined {
  if (read.state === "unreadable") {
    return refusal("unreadable", `The access records cannot be read: ${read.reason}.`);
  }
  return read.state === "present" ? read.snapshot : undefined;
}

/**
 * Run one change while the caller already holds the access lock (inside
 * `withLedgerLock` on the principals ledger): the same checks, plan and writes as
 * {@link runMutation}, without taking the lock again.
 */
export function runMutationLocked<T>(
  ctx: AccessContext,
  actor: AccessActor | undefined,
  plan: (state: Planning) => Promise<Change<T> | Refusal> | Change<T> | Refusal,
  options: MutationOptions,
): Promise<Done<T> | Refusal> {
  return runLocked(ctx, actor, plan, options);
}

/** Run one change under the access lock. */
export async function runMutation<T>(
  ctx: AccessContext,
  actor: AccessActor | undefined,
  plan: (state: Planning) => Promise<Change<T> | Refusal> | Change<T> | Refusal,
  options: MutationOptions,
): Promise<Done<T> | Refusal> {
  // Nothing is created for a change that cannot run: the lock lives inside `access/`.
  if (options.setup === undefined && loadAccessSnapshot(ctx.root).state === "absent") {
    return refusal("not-set-up", "Nobody else has access to this Home yet.");
  }
  const lockLedger = accessLedger(ctx.root, "principals");
  try {
    const locked = await withLedgerLock(lockLedger, () => runLocked(ctx, actor, plan, options));
    if (locked.ok === false && "path" in locked) {
      return refusal("io-error", `The access records could not be changed: ${locked.reason}`);
    }
    return locked as Done<T> | Refusal;
  } catch (err) {
    return refusal(
      "io-error",
      `The access records could not be locked: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runLocked<T>(
  ctx: AccessContext,
  actor: AccessActor | undefined,
  plan: (state: Planning) => Promise<Change<T> | Refusal> | Change<T> | Refusal,
  options: MutationOptions,
): Promise<Done<T> | Refusal> {
  const now = ctx.now();
  const at = new Date(now).toISOString();
  const loaded = snapshotOf(loadAccessSnapshot(ctx.root));
  if (loaded !== undefined && "ok" in loaded) return loaded;
  const snapshot = loaded;
  if (options.setup === undefined) {
    if (snapshot === undefined) {
      return refusal("not-set-up", "Nobody else has access to this Home yet.");
    }
    if (options.own === true) {
      const who = snapshot.principals.find((row) => row.id === actor?.principal);
      if (who === undefined || who.state !== "active") {
        return refusal("not-authorized", "Only an active member can do this.");
      }
    } else {
      const verdict =
        actor === undefined
          ? undefined
          : authorize(snapshot, actor, "home.access.manage", HOME, {
              now,
              domains: ctx.domains,
            });
      if (verdict?.allow !== true) {
        return refusal("not-authorized", "Only this Home's owner can change who has access.");
      }
    }
  }
  const by = options.setup?.by(snapshot) ?? (actor as AccessActor).principal;
  const planned = await plan({ snapshot, now, at, by });
  if ("ok" in planned) return planned;
  const plannedRows = rowsOf(planned);
  const subjectsChanged =
    planned.subjects !== undefined &&
    (snapshot === undefined || subjectsText(planned.subjects) !== subjectsText(snapshot.subjects));
  const epoch = snapshot?.epoch ?? 0;
  if (plannedRows.length === 0 && !subjectsChanged) {
    return { ok: true, result: planned.result, epoch, projections: EMPTY_REPORT };
  }
  for (const { row } of plannedRows) {
    if (lineBytes(row) >= MAX_ROW_BYTES) {
      return refusal(
        "too-large",
        `This change makes a record of ${lineBytes(row)} bytes, over the ${MAX_ROW_BYTES}-byte limit; nothing was written.`,
      );
    }
  }
  const skipped = new Set<string>();
  for (const claim of planned.claims ?? []) {
    const published = publishClaim(accessLedger(ctx.root, claim.kind), claim.claim, {
      ...claim.row,
    });
    if (!published.ok) {
      if (published.code === "exists" && claim.taken === "skip") {
        skipped.add(claim.claim);
        continue;
      }
      return published.code === "exists"
        ? (claim.taken as Refusal)
        : refusal("io-error", `The access records could not be changed: ${published.reason}`);
    }
  }
  const rows = rowsOf(planned, skipped);
  // Names go first: an erasure that stops part-way has already erased, and a name written
  // for a member whose rows then fail to land belongs to no principal.
  if (subjectsChanged && planned.subjects !== undefined) {
    const rewritten = writeSubjects(ctx.root, planned.subjects);
    if (!rewritten.ok) return refusal("io-error", `Nothing was changed: ${rewritten.reason}`);
  }
  let landed = 0;
  let failure: string | undefined;
  for (const { kind, row } of rows) {
    const rel = accessPaths().ledgers[kind];
    const sealed = sealTornLine(ctx.root, rel);
    if (!sealed.ok) {
      failure = sealed.reason;
      break;
    }
    const written = append(accessLedger(ctx.root, kind), row);
    if (!written.ok) {
      failure = written.reason;
      break;
    }
    landed += 1;
  }
  const next = landed > 0 || subjectsChanged ? nextEpoch(ctx, epoch, now) : epoch;
  if (next !== epoch) {
    const moved = writeRevision(ctx.root, next, at);
    if (!moved.ok && failure === undefined) failure = moved.reason;
  }
  if (failure !== undefined) {
    return refusal(
      "io-error",
      `${landed === 0 ? "Nothing was changed" : "The change was only partly recorded"}: ${failure}`,
    );
  }
  const projections = options.projections
    ? projectAfter(ctx, { epoch: next, now, by })
    : EMPTY_REPORT;
  return { ok: true, result: planned.result, epoch: next, projections };
}

/**
 * The revision after a change: one above both the recorded revision and every registered
 * harness's approver file, so a lost or rewound `revision.json` cannot leave a file ahead
 * of the records. Under the access lock only.
 */
export function nextEpoch(ctx: AccessContext, epoch: number, now: number): number {
  return Math.max(epoch, projectionEpochFloor(ctx, now)) + 1;
}

/** The highest `epoch` of any registered harness's approver file; 0 when none can be read. */
export function projectionEpochFloor(ctx: AccessContext, now: number): number {
  try {
    return highestProjectionEpoch(ctx.harnesses(), now);
  } catch {
    return 0;
  }
}

/** Bring the projections to the records as they are now. Under the access lock only. */
export function projectAfter(
  ctx: AccessContext,
  input: { readonly epoch: number; readonly now: number; readonly by: string },
): ProjectionReport {
  const everyHarness = (reason: string): ProjectionReport => ({
    ...EMPTY_REPORT,
    failed: [{ harness: "every governed harness", reason }],
  });
  const after = snapshotOf(loadAccessSnapshot(ctx.root));
  if (after === undefined) return EMPTY_REPORT;
  if ("ok" in after) return everyHarness(after.reason);
  try {
    return writeApproverProjections({
      root: ctx.root,
      snapshot: after,
      harnesses: ctx.harnesses(),
      ...input,
    });
  } catch (err) {
    return everyHarness(err instanceof Error ? err.message : String(err));
  }
}
