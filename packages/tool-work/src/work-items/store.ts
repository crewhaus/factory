/**
 * The work store: one harness's work items, through the content-free log and the
 * immutable content revisions `./records` describes. Node-only; it spawns nothing.
 *
 * - Every write folds the whole log and appends under the harness's control lock, so two
 *   writers never decide on the same state. A content revision (`rev = n + 1`) is written,
 *   exclusively, before the line that names it; `update` is compare-and-set on `expect`
 *   (a stale one is refused `precondition_failed`, naming the current revision).
 * - A move the machine or the actor rules refuse is refused before anything is written:
 *   `conflict` naming the current state, or `forbidden` naming the role.
 * - A proposal or an adoption with a source is one exactly-once step: the source's claim
 *   (a keyed digest of its kind and reference) is checked first, so a repeat writes
 *   nothing; a new item's first revision is written, then the claim is taken and its
 *   record, the `opened` line, appended in one locked step. A writer that loses the race
 *   removes the item directory it created and answers the winner's item.
 * - Reads take no lock and write nothing; the digest key is created only on a write.
 *
 * Each mutating call records the receipt it runs under (`cmd`) when it has one.
 */
import { closeSync, rmSync, writeSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { TrustOrigin } from "@crewhaus/boundary-classifier";
import {
  CANONICAL_RUN_ID_RE,
  type CorrectionScope,
  DECLINE_REASONS,
  WORK_BASES,
  WORK_CLOSE_OUTCOMES,
  WORK_KINDS,
  WORK_SOURCE_LABEL,
  type WorkBasis,
  type WorkCloseOutcome,
  type WorkDeliveryKind,
  type WorkKind,
  type WorkSourceKind,
  isId,
  isRef,
  isStoredActor,
  mintId,
  parseRef,
} from "@crewhaus/control-contract";
import {
  type LedgerRecord,
  appendClaim,
  ensureDigestKey,
  keyedDigest,
  readClaim,
  withLedgerLock,
} from "@crewhaus/control-records";
import {
  createExclusive,
  ensureDirContained,
  openForReadSync,
  resolveContained,
} from "@crewhaus/tool-safety/fs";
import {
  ACCEPT_RULE,
  HARNESS_CLOSE_OUTCOMES,
  HARNESS_SOURCE_KINDS,
  type WorkMove,
  mayMove,
} from "./actors";
import { checkProposal, hasObservedEvidence, parseAssessment } from "./assessment";
import { type FoldedWorkItem, type WorkFold, foldWork } from "./fold";
import {
  REVISION_MAX_BYTES,
  SOURCE_EXCERPT_MAX,
  WORK_SOURCE_CLAIM_KIND,
  type WorkActor,
  type WorkDelivery,
  type WorkLogLine,
  type WorkNote,
  type WorkRevision,
  type WorkSource,
  type WorkTextField,
  itemDirOf,
  originOfRole,
  revisionRelOf,
  strayKeys,
  workLedger,
} from "./records";

export type WorkRefusalCode =
  | "invalid"
  | "not_found"
  | "conflict"
  | "precondition_failed"
  | "forbidden"
  | "unsupported"
  | "unavailable";

export type WorkRefusal = {
  readonly ok: false;
  readonly code: WorkRefusalCode;
  /** A short code a client branches on: `not_proposed`, `assessment_invalid`, … */
  readonly reason: string;
  readonly message: string;
  /** The state or revision found, when the refusal is about it. */
  readonly current?: string | number;
  /** The field at fault, for an invalid input. */
  readonly field?: string;
};

export type WorkWrite =
  | {
      readonly ok: true;
      readonly item: FoldedWorkItem;
      /** False when nothing needed writing (a repeat). */
      readonly wrote: boolean;
    }
  | WorkRefusal;

/** What a new item says. Text fields are bounded; see `./records`. */
export type WorkInput = {
  readonly title: string;
  readonly goal?: string;
  readonly acceptance?: readonly string[];
  readonly kind: WorkKind;
  readonly basis?: WorkBasis;
  readonly parent?: string;
  readonly priority?: number;
  readonly assessment?: unknown;
  readonly source?: WorkSource;
};

export type WorkPatch = {
  /** The revision the caller read. */
  readonly expect: number;
  readonly title?: string;
  readonly goal?: string;
  readonly acceptance?: readonly string[];
  readonly kind?: WorkKind;
  readonly basis?: WorkBasis;
  readonly parent?: string;
  readonly priority?: number;
  readonly assessment?: unknown;
  readonly note?: string;
};

export type WorkTransition = {
  readonly outcome?: WorkCloseOutcome;
  readonly reasonCode?: string;
  readonly supersededBy?: string;
  readonly note?: string;
};

/** The owner's accept policy, from `tool_config.work.accept`. */
export type WorkAcceptPolicy = { readonly accept?: readonly WorkKind[] };

/** What a source reads as, for an adoption: its text and the origin it came through. */
export type AdoptedText = {
  readonly title: string;
  readonly goal?: string;
  readonly url?: string;
  readonly excerpt?: string;
  readonly kind?: WorkKind;
  readonly origin: TrustOrigin;
};

export type AdoptRead = () => Promise<AdoptedText | WorkRefusal>;

export type WorkItemRead = {
  readonly item: FoldedWorkItem;
  /** The latest content revision, or `undefined` when it could not be read. */
  readonly revision: WorkRevision | undefined;
  readonly unreadable?: string;
};

export type WorkStore = {
  create(input: WorkInput, actor: WorkActor): Promise<WorkWrite>;
  propose(
    input: WorkInput,
    actor: WorkActor,
    options?: { readonly policy?: WorkAcceptPolicy },
  ): Promise<WorkWrite>;
  update(wi: string, patch: WorkPatch, actor: WorkActor): Promise<WorkWrite>;
  transition(
    wi: string,
    to: "open" | "closed",
    options: WorkTransition,
    actor: WorkActor,
    rule?: string,
  ): Promise<WorkWrite>;
  link(wi: string, run: string, actor: WorkActor): Promise<WorkWrite>;
  rank(
    wi: string,
    order: { readonly below: string; readonly scope: CorrectionScope },
    actor: WorkActor,
  ): Promise<WorkWrite>;
  deliver(
    wi: string,
    delivery: { readonly kind: WorkDeliveryKind; readonly ref: string },
    actor: WorkActor,
  ): Promise<WorkWrite>;
  adopt(
    source: { readonly kind: WorkSourceKind; readonly ref: string },
    read: AdoptRead,
    actor: WorkActor,
  ): Promise<WorkWrite>;
  /** One item and its latest content. `undefined` when the log has no such item. */
  get(wi: string): WorkItemRead | WorkRefusal;
  /** The items, newest first, at most `cap` read lines folded. */
  list(options?: { readonly state?: string; readonly cap?: number }): {
    readonly items: readonly FoldedWorkItem[];
    readonly truncated: boolean;
    readonly anomalies: number;
  };
  fold(cap?: number): WorkFold | WorkRefusal;
  /** One content revision, read contained. */
  revision(wi: string, rev: number): WorkRevision | undefined;
};

export type WorkStoreOptions = {
  readonly now?: () => number;
  /**
   * Where a new item's id comes from; a fresh `wi_` ULID by default. A seed passes a
   * deterministic one. Anything that is not a `wi_` id is refused before a write.
   */
  readonly mintId?: () => string;
};

/** Lines a read folds at most before it says it was cut short. */
export const WORK_READ_CAP = 50_000;

const TITLE_MAX = 200;
const GOAL_MAX = 8192;
const CRITERIA_MAX = 20;
const CRITERION_MAX = 500;
const NOTE_MAX = 4096;
const REF_MAX = 500;

function refusal(
  code: WorkRefusalCode,
  reason: string,
  message: string,
  more: { readonly current?: string | number; readonly field?: string } = {},
): WorkRefusal {
  return { ok: false, code, reason, message, ...more };
}

/** A lock that could not be taken, as a refusal; any other answer as it is. */
function settled(answer: WorkWrite | { readonly ok: false; readonly reason: string }): WorkWrite {
  if (answer.ok || "message" in answer) return answer;
  return refusal("unavailable", "store_unwritable", answer.reason);
}

function forbidden(actor: WorkActor, move: WorkMove | "adopt"): WorkRefusal {
  const who = actor.role === "harness" ? "The harness" : `A ${actor.role}`;
  return refusal("forbidden", "actor_not_allowed", `${who} cannot ${move} a work item.`);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A text field's problem, or `undefined` when it is fine. */
function textProblem(field: string, value: unknown, max: number): WorkRefusal | undefined {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    return refusal("invalid", "invalid_field", `${field} is text of 1 to ${max} characters.`, {
      field,
    });
  }
  return undefined;
}

function criteriaProblem(value: unknown): WorkRefusal | undefined {
  if (
    !Array.isArray(value) ||
    value.length > CRITERIA_MAX ||
    value.some((c) => typeof c !== "string" || c.trim() === "" || c.length > CRITERION_MAX)
  ) {
    return refusal(
      "invalid",
      "invalid_field",
      `acceptance is a list of at most ${CRITERIA_MAX} criteria of ${CRITERION_MAX} characters.`,
      { field: "acceptance" },
    );
  }
  return undefined;
}

function isParent(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (isId("wi", value)) return true;
  if (!isRef(value)) return false;
  const parsed = parseRef(value);
  return !("error" in parsed) && parsed.kind === "work";
}

/** Check the fields an input or a patch sets; `undefined` when all are fine. */
function fieldsProblem(
  fields: Partial<WorkInput> & { readonly note?: unknown },
): WorkRefusal | undefined {
  if (fields.title !== undefined) {
    const p = textProblem("title", fields.title, TITLE_MAX);
    if (p !== undefined) return p;
  }
  if (fields.goal !== undefined) {
    const p = textProblem("goal", fields.goal, GOAL_MAX);
    if (p !== undefined) return p;
  }
  if (fields.acceptance !== undefined) {
    const p = criteriaProblem(fields.acceptance);
    if (p !== undefined) return p;
  }
  if (fields.note !== undefined) {
    const p = textProblem("note", fields.note, NOTE_MAX);
    if (p !== undefined) return p;
  }
  if (fields.kind !== undefined && !(WORK_KINDS as readonly unknown[]).includes(fields.kind)) {
    return refusal("invalid", "invalid_field", `kind is one of ${WORK_KINDS.join(", ")}.`, {
      field: "kind",
    });
  }
  if (fields.basis !== undefined && !(WORK_BASES as readonly unknown[]).includes(fields.basis)) {
    return refusal("invalid", "invalid_field", `basis is one of ${WORK_BASES.join(", ")}.`, {
      field: "basis",
    });
  }
  if (
    fields.priority !== undefined &&
    (!Number.isInteger(fields.priority) || fields.priority < 1 || fields.priority > 4)
  ) {
    return refusal("invalid", "invalid_field", "priority is 1 (first) to 4.", {
      field: "priority",
    });
  }
  if (fields.parent !== undefined && !isParent(fields.parent)) {
    return refusal("invalid", "invalid_field", "parent names a work item (wi_…).", {
      field: "parent",
    });
  }
  return undefined;
}

/**
 * The first problem with the fields an input or a patch sets, or `undefined`: what the
 * store would refuse them for. A head asks before it writes a receipt.
 */
export function workFieldsProblem(
  fields: Partial<WorkInput> & { readonly note?: unknown },
): WorkRefusal | undefined {
  return fieldsProblem(fields);
}

/** The work store of the harness at `harnessDir`. Opening it reads and writes nothing. */
export function openWorkStore(harnessDir: string, options: WorkStoreOptions = {}): WorkStore {
  const ledger = workLedger(harnessDir);
  const now = options.now ?? Date.now;
  const mint = (): string => {
    const id = options.mintId?.() ?? mintId("wi");
    if (!isId("wi", id)) throw new Error("a work item's id is wi_ and a ULID");
    return id;
  };
  const stampNow = (): string => new Date(now()).toISOString();

  function readRevision(wi: string, rev: number): WorkRevision | undefined {
    if (!isId("wi", wi) || !Number.isSafeInteger(rev) || rev < 1) return undefined;
    const read = openForReadSync(harnessDir, revisionRelOf(harnessDir, wi, rev), {
      maxBytes: REVISION_MAX_BYTES,
      followLeafSymlink: false,
    });
    if (!read.ok || read.truncated) return undefined;
    try {
      const body = JSON.parse(read.text) as WorkRevision;
      if (body?.v !== 1 || body.wi !== wi || body.rev !== rev || typeof body.title !== "string") {
        return undefined;
      }
      return body;
    } catch {
      return undefined;
    }
  }

  /**
   * Write one revision, exclusively, `0600`; never over an existing one. `named` is the
   * newest revision a log line names, given only under the ledger's lock: a file above it
   * is one no line names (a writer that stopped between its revision and its line), so it
   * is removed and written again instead of blocking every later edit of the item.
   */
  function writeRevision(revision: WorkRevision, named?: number): WorkRefusal | undefined {
    const dir = ensureDirContained(harnessDir, itemDirOf(harnessDir, revision.wi), { mode: 0o700 });
    if (!dir.ok) return refusal("unavailable", "store_unwritable", dir.reason);
    const rel = revisionRelOf(harnessDir, revision.wi, revision.rev);
    let created = createExclusive(harnessDir, rel, { mode: 0o600 });
    if (!created.ok && created.code === "exists" && named !== undefined && revision.rev > named) {
      removeRevision(revision.wi, revision.rev);
      created = createExclusive(harnessDir, rel, { mode: 0o600 });
    }
    if (!created.ok) {
      return created.code === "exists"
        ? refusal("conflict", "revision_exists", "That revision was written already.", {
            current: revision.rev,
          })
        : refusal("unavailable", "store_unwritable", created.reason);
    }
    try {
      writeSync(created.fd, `${JSON.stringify(revision)}\n`);
    } catch (err) {
      return refusal("unavailable", "store_unwritable", (err as Error).message);
    } finally {
      closeSync(created.fd);
    }
    return undefined;
  }

  /** Remove one revision file no log line names: contained, never followed out. */
  function removeRevision(wi: string, rev: number): void {
    const at = resolveContained(harnessDir, revisionRelOf(harnessDir, wi, rev), {
      followLeaf: false,
    });
    if (!at.ok) return;
    const root = resolveContained(harnessDir, ".");
    if (!root.ok) return;
    const rel = relative(root.real, at.real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
    rmSync(at.real, { force: true });
  }

  /** Remove an item directory this call created and nothing names: contained, never followed out. */
  function removeOrphan(wi: string): void {
    const at = resolveContained(harnessDir, itemDirOf(harnessDir, wi), { followLeaf: false });
    if (!at.ok) return;
    const root = resolveContained(harnessDir, ".");
    if (!root.ok) return;
    const rel = relative(root.real, at.real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
    rmSync(at.real, { recursive: true, force: true });
  }

  function line(
    fields: Omit<WorkLogLine, "v" | "at" | "by" | "via">,
    actor: WorkActor,
  ): WorkLogLine {
    const out: WorkLogLine = {
      v: 1,
      at: stampNow(),
      ...fields,
      by: actor.by,
      via: actor.via,
      ...(actor.cmd !== undefined ? { cmd: actor.cmd } : {}),
      ...(actor.run !== undefined && fields.run === undefined ? { run: actor.run } : {}),
    };
    const stray = strayKeys(out as unknown as Record<string, unknown>);
    if (stray.length > 0)
      throw new Error(`work log line has keys outside the set: ${stray.join(", ")}`);
    return out;
  }

  function actorProblem(actor: WorkActor): WorkRefusal | undefined {
    if (!isStoredActor(actor.by)) {
      return refusal("invalid", "invalid_actor", "A work record holds a stored actor only.");
    }
    if (actor.run !== undefined && !CANONICAL_RUN_ID_RE.test(actor.run)) {
      return refusal("invalid", "invalid_actor", "A run is named by its canonical id (run_…).");
    }
    return undefined;
  }

  function sourceOf(input: WorkInput, actor: WorkActor): WorkSource | WorkRefusal {
    const given = input.source;
    if (actor.role === "harness") {
      const kind = given?.kind ?? "agent";
      if (!HARNESS_SOURCE_KINDS.includes(kind)) {
        return refusal(
          "forbidden",
          "source_not_allowed",
          `The harness cannot claim a source of kind ${kind}.`,
          { field: "source.kind" },
        );
      }
      return {
        kind,
        ...(given?.ref !== undefined ? { ref: given.ref } : {}),
        ...(given?.url !== undefined ? { url: given.url } : {}),
      };
    }
    if (given !== undefined) return given;
    return {
      kind: actor.role === "service" ? "api" : actor.role === "person" ? "operator" : "agent",
    };
  }

  function firstRevision(
    wi: string,
    input: WorkInput,
    source: WorkSource,
    actor: WorkActor,
    origin: TrustOrigin,
    assessment: WorkRevision["assessment"],
    excerpt?: string,
  ): WorkRevision {
    const origins: Partial<Record<WorkTextField, TrustOrigin>> = { title: origin };
    if (input.goal !== undefined) origins.goal = origin;
    if (input.acceptance !== undefined) origins.acceptance = origin;
    if (assessment !== undefined) origins.assessment = origin;
    if (source.ref !== undefined || source.url !== undefined) origins.source = origin;
    if (excerpt !== undefined) origins.excerpt = origin;
    return {
      v: 1,
      wi,
      rev: 1,
      at: stampNow(),
      by: actor.by,
      title: oneLine(input.title),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.acceptance !== undefined ? { acceptance: [...input.acceptance] } : {}),
      kind: input.kind,
      ...(input.basis !== undefined ? { basis: input.basis } : {}),
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
      source,
      ...(assessment !== undefined ? { assessment } : {}),
      fieldOrigins: origins,
      ...(excerpt !== undefined ? { sourceExcerpt: excerpt.slice(0, SOURCE_EXCERPT_MAX) } : {}),
    };
  }

  function openedLine(
    wi: string,
    state: "proposed" | "open",
    input: WorkInput,
    source: WorkSource,
    actor: WorkActor,
    sourceDigest?: string,
  ): WorkLogLine {
    return line(
      {
        id: wi,
        state,
        event: "opened",
        rev: 1,
        kind: input.kind,
        ...(input.basis !== undefined ? { basis: input.basis } : {}),
        sourceKind: source.kind,
        ...(sourceDigest !== undefined ? { sourceDigest } : {}),
        ...(input.parent !== undefined ? { parent: input.parent } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      },
      actor,
    );
  }

  function wholeFold(): WorkFold | WorkRefusal {
    const fold = foldWork(harnessDir);
    if (!fold.ok) return refusal("unavailable", "log_unreadable", fold.reason);
    if (fold.gaps > 0) {
      return refusal(
        "unavailable",
        "log_unreadable",
        "Part of the work log could not be read, so nothing was written.",
      );
    }
    return fold;
  }

  /** Append one line under the lock after a whole fold; `decide` refuses or names the line. */
  async function locked(
    wi: string,
    decide: (
      item: FoldedWorkItem,
      fold: WorkFold,
    ) => WorkRefusal | { readonly line?: WorkLogLine; readonly revision?: WorkRevision },
  ): Promise<WorkWrite> {
    const answer = await withLedgerLock<WorkWrite>(ledger, (lockedAppend) => {
      const fold = wholeFold();
      if (!fold.ok) return fold;
      const item = fold.items.get(wi);
      if (item === undefined) {
        return refusal("not_found", "work_unknown", "This harness has no such work item.");
      }
      const decided = decide(item, fold);
      if ("ok" in decided) return decided;
      if (decided.line === undefined) return { ok: true, item, wrote: false };
      if (decided.revision !== undefined) {
        const problem = writeRevision(decided.revision, item.rev);
        if (problem !== undefined) return problem;
      }
      const written = lockedAppend(decided.line as unknown as LedgerRecord);
      if (!written.ok) {
        // No line names the revision this call wrote: remove it, so the next edit can.
        if (decided.revision !== undefined) {
          removeRevision(decided.revision.wi, decided.revision.rev);
        }
        return refusal("unavailable", "store_unwritable", written.reason);
      }
      const after = foldWork(harnessDir);
      const folded = after.ok ? after.items.get(wi) : undefined;
      return { ok: true, item: folded ?? item, wrote: true };
    });
    return settled(answer);
  }

  async function appendNew(
    wi: string,
    revision: WorkRevision,
    opened: WorkLogLine,
  ): Promise<WorkWrite> {
    const answer = await withLedgerLock<WorkWrite>(ledger, (lockedAppend) => {
      const problem = writeRevision(revision);
      if (problem !== undefined) return problem;
      const written = lockedAppend(opened as unknown as LedgerRecord);
      if (!written.ok) {
        removeOrphan(wi);
        return refusal("unavailable", "store_unwritable", written.reason);
      }
      const fold = foldWork(harnessDir);
      const item = fold.ok ? fold.items.get(wi) : undefined;
      return item === undefined
        ? refusal("unavailable", "log_unreadable", "The new item could not be read back.")
        : { ok: true, item, wrote: true };
    });
    return settled(answer);
  }

  /** The source claim's name: a keyed digest of the source, never the source itself. */
  async function claimOf(
    kind: WorkSourceKind,
    ref: string,
  ): Promise<{ readonly claim: string; readonly digest: string } | WorkRefusal> {
    const key = await ensureDigestKey(harnessDir);
    if (key.state !== "present") return refusal("unavailable", "digest_key", key.reason);
    const digest = await keyedDigest(key.hmac, WORK_SOURCE_LABEL, [kind, ref]);
    return { claim: `${WORK_SOURCE_CLAIM_KIND}/${digest}`, digest };
  }

  /** The item a claimed source already opened, repairing a winner that died before its line. */
  async function claimedItem(claim: string): Promise<WorkWrite | undefined> {
    const existing = readClaim(ledger, claim);
    if (!existing.ok) return undefined;
    const id = existing.content.record["id"];
    if (typeof id !== "string") {
      return refusal("unavailable", "claim_unreadable", "The source's claim names no item.");
    }
    let fold = foldWork(harnessDir);
    let item = fold.ok ? fold.items.get(id) : undefined;
    if (item === undefined) {
      // The winner died between its claim and its line: complete it, once.
      await appendClaim(ledger, { claim, record: existing.content.record });
      fold = foldWork(harnessDir);
      item = fold.ok ? fold.items.get(id) : undefined;
    }
    return item === undefined
      ? refusal("unavailable", "log_unreadable", "The claimed item could not be read back.")
      : { ok: true, item, wrote: false };
  }

  /** Open a sourced item exactly once: check, write revision 1, take the claim with its line. */
  async function openSourced(
    kind: WorkSourceKind,
    ref: string,
    build: (
      wi: string,
      digest: string,
    ) => Promise<{ readonly revision: WorkRevision; readonly opened: WorkLogLine } | WorkRefusal>,
  ): Promise<WorkWrite> {
    const named = await claimOf(kind, ref);
    if ("ok" in named) return named;
    const repeat = await claimedItem(named.claim);
    if (repeat !== undefined) return repeat;
    const wi = mint();
    const built = await build(wi, named.digest);
    if ("ok" in built) return built;
    const problem = writeRevision(built.revision);
    if (problem !== undefined) return problem;
    const claimed = await appendClaim(ledger, {
      claim: named.claim,
      record: built.opened as unknown as LedgerRecord,
    });
    if (!claimed.ok) {
      removeOrphan(wi);
      return refusal("unavailable", "store_unwritable", claimed.reason);
    }
    if (!claimed.won) {
      removeOrphan(wi);
      const winner = claimed.winner.record["id"];
      const fold = foldWork(harnessDir);
      const item = fold.ok && typeof winner === "string" ? fold.items.get(winner) : undefined;
      return item === undefined
        ? refusal("unavailable", "log_unreadable", "The claimed item could not be read back.")
        : { ok: true, item, wrote: false };
    }
    const fold = foldWork(harnessDir);
    const item = fold.ok ? fold.items.get(wi) : undefined;
    return item === undefined
      ? refusal("unavailable", "log_unreadable", "The new item could not be read back.")
      : { ok: true, item, wrote: true };
  }

  const store: WorkStore = {
    async create(input, actor) {
      const bad =
        actorProblem(actor) ?? (mayMove(actor.role, "open") ? undefined : forbidden(actor, "open"));
      if (bad !== undefined) return bad;
      const problem = fieldsProblem(input);
      if (problem !== undefined) return problem;
      let assessment: WorkRevision["assessment"];
      if (input.assessment !== undefined) {
        const parsed = parseAssessment(input.assessment, stampNow());
        if (!parsed.ok) {
          return refusal("invalid", parsed.code, parsed.message, { field: parsed.field });
        }
        assessment = parsed.assessment;
      }
      const source = sourceOf(input, actor);
      if ("ok" in source) return source;
      const wi = mint();
      const origin = originOfRole(actor.role);
      return appendNew(
        wi,
        firstRevision(wi, input, source, actor, origin, assessment),
        openedLine(wi, "open", input, source, actor),
      );
    },

    async propose(input, actor, opts = {}) {
      const bad =
        actorProblem(actor) ??
        (mayMove(actor.role, "propose") ? undefined : forbidden(actor, "propose"));
      if (bad !== undefined) return bad;
      const problem = fieldsProblem(input);
      if (problem !== undefined) return problem;
      let assessment: WorkRevision["assessment"];
      if (input.assessment !== undefined) {
        const parsed = parseAssessment(input.assessment, stampNow());
        if (!parsed.ok) {
          return refusal("invalid", parsed.code, parsed.message, { field: parsed.field });
        }
        assessment = parsed.assessment;
      }
      const proposal = checkProposal({ kind: input.kind, basis: input.basis, assessment });
      if (!proposal.ok) {
        return refusal("invalid", proposal.code, proposal.message, { field: proposal.field });
      }
      const source = sourceOf(input, actor);
      if ("ok" in source) return source;
      if (
        source.ref !== undefined &&
        (typeof source.ref !== "string" || source.ref.length > REF_MAX)
      ) {
        return refusal("invalid", "invalid_field", "source.ref is a short reference.", {
          field: "source.ref",
        });
      }
      const origin = originOfRole(actor.role);
      const written =
        source.ref !== undefined
          ? await openSourced(source.kind, source.ref, async (wi, digest) => ({
              revision: firstRevision(wi, input, source, actor, origin, assessment),
              opened: openedLine(wi, "proposed", input, source, actor, digest),
            }))
          : await (async () => {
              const wi = mint();
              return appendNew(
                wi,
                firstRevision(wi, input, source, actor, origin, assessment),
                openedLine(wi, "proposed", input, source, actor),
              );
            })();
      if (!written.ok || !written.wrote) return written;
      // The owner's accept policy: a listed kind is accepted by the runtime, except a
      // feature or a speculative proposal of any kind with no observed evidence, which
      // waits for a person.
      const accept = opts.policy?.accept ?? [];
      const needsObserved = input.kind === "feature" || input.basis === "speculative";
      if (accept.includes(input.kind) && (!needsObserved || hasObservedEvidence(assessment))) {
        const accepted = await store.transition(
          written.item.id,
          "open",
          {},
          { by: "sys:runtime", via: "system", role: "system" },
          ACCEPT_RULE,
        );
        if (accepted.ok) return { ok: true, item: accepted.item, wrote: true };
      }
      return written;
    },

    async update(wi, patch, actor) {
      const bad = actorProblem(actor);
      if (bad !== undefined) return bad;
      const { expect, note, ...fields } = patch;
      const editing = Object.values(fields).some((v) => v !== undefined);
      const move: WorkMove = editing ? "edit" : "note";
      if (!mayMove(actor.role, move)) return forbidden(actor, move);
      if (!editing && note === undefined) {
        return refusal("invalid", "nothing_to_change", "Say what changes: a field or a note.");
      }
      const problem = fieldsProblem({ ...fields, ...(note !== undefined ? { note } : {}) });
      if (problem !== undefined) return problem;
      let assessment: WorkRevision["assessment"];
      if (fields.assessment !== undefined) {
        const parsed = parseAssessment(fields.assessment, stampNow());
        if (!parsed.ok) {
          return refusal("invalid", parsed.code, parsed.message, { field: parsed.field });
        }
        assessment = parsed.assessment;
      }
      return locked(wi, (item) => {
        if (
          editing &&
          actor.role === "harness" &&
          (item.state !== "proposed" || item.openedVia !== "tool")
        ) {
          return refusal(
            "forbidden",
            "not_its_proposal",
            "The harness edits only its own proposals, before anyone accepts them.",
            { current: item.state },
          );
        }
        if (!Number.isSafeInteger(expect) || expect !== item.rev) {
          return refusal(
            "precondition_failed",
            "stale_revision",
            `This item is at revision ${item.rev}; read it again before you change it.`,
            { current: item.rev },
          );
        }
        const current = readRevision(wi, item.rev);
        if (current === undefined) {
          return refusal(
            "unavailable",
            "content_unreadable",
            "The item's content could not be read.",
          );
        }
        const origin = originOfRole(actor.role);
        const origins: Partial<Record<WorkTextField, TrustOrigin>> = { ...current.fieldOrigins };
        const next: Record<string, unknown> = {
          ...current,
          rev: item.rev + 1,
          at: stampNow(),
          by: actor.by,
        };
        if (fields.title !== undefined) {
          next["title"] = oneLine(fields.title);
          origins.title = origin;
        }
        if (fields.goal !== undefined) {
          next["goal"] = fields.goal;
          origins.goal = origin;
        }
        if (fields.acceptance !== undefined) {
          next["acceptance"] = [...fields.acceptance];
          origins.acceptance = origin;
        }
        if (assessment !== undefined) {
          next["assessment"] = assessment;
          origins.assessment = origin;
        }
        for (const key of ["kind", "basis", "parent"] as const) {
          if (fields[key] !== undefined) next[key] = fields[key];
        }
        if (note !== undefined) {
          const added: WorkNote = { by: actor.by, at: stampNow(), text: note, origin };
          next["notes"] = [...(current.notes ?? []), added];
        }
        next["fieldOrigins"] = origins;
        const revision = next as WorkRevision;
        if (
          item.state === "proposed" &&
          (fields.kind !== undefined || fields.basis !== undefined || assessment !== undefined)
        ) {
          const proposal = checkProposal({
            kind: revision.kind,
            basis: revision.basis,
            assessment: revision.assessment,
          });
          if (!proposal.ok) {
            return refusal("invalid", proposal.code, proposal.message, { field: proposal.field });
          }
        }
        return {
          revision,
          line: line(
            {
              id: wi,
              state: item.state,
              event: "updated",
              rev: revision.rev,
              ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
              ...(fields.basis !== undefined ? { basis: fields.basis } : {}),
              ...(fields.parent !== undefined ? { parent: fields.parent } : {}),
              ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
            },
            actor,
          ),
        };
      });
    },

    async transition(wi, to, opts, actor, rule) {
      const bad = actorProblem(actor);
      if (bad !== undefined) return bad;
      if (opts.note !== undefined) {
        const p = textProblem("note", opts.note, NOTE_MAX);
        if (p !== undefined) return p;
      }
      if (opts.supersededBy !== undefined && !isId("wi", opts.supersededBy)) {
        return refusal("invalid", "invalid_field", "supersededBy names a work item (wi_…).", {
          field: "supersededBy",
        });
      }
      return locked(wi, (item, fold) => {
        const from = item.state;
        let move: WorkMove;
        let event: WorkLogLine["event"];
        let outcome: WorkCloseOutcome | undefined;
        if (to === "open" && from === "proposed") {
          move = "accept";
          event = "accepted";
        } else if (to === "open" && from === "closed") {
          move = "reopen";
          event = "reopened";
        } else if (to === "closed" && from === "proposed") {
          move = "decline";
          event = "declined";
          outcome = opts.supersededBy !== undefined ? "superseded" : "declined";
          if (!(DECLINE_REASONS as readonly unknown[]).includes(opts.reasonCode)) {
            return refusal(
              "invalid",
              "invalid_field",
              `A decline gives a reason: ${DECLINE_REASONS.join(", ")}.`,
              {
                field: "reason",
              },
            );
          }
        } else if (to === "closed" && from === "open") {
          outcome = opts.outcome ?? "done";
          if (!(WORK_CLOSE_OUTCOMES as readonly string[]).includes(outcome)) {
            return refusal("invalid", "invalid_field", "outcome is not one an item closes with.", {
              field: "outcome",
            });
          }
          move = outcome === "cancelled" ? "cancel" : "close";
          event = "closed";
          if (outcome === "declined" && actor.role !== "system") return forbidden(actor, "decline");
          if (actor.role === "harness") {
            if (!HARNESS_CLOSE_OUTCOMES.includes(outcome)) return forbidden(actor, move);
            if (
              typeof opts.reasonCode !== "string" ||
              !/^[a-z][a-z0-9-]{0,39}$/.test(opts.reasonCode)
            ) {
              return refusal(
                "invalid",
                "reason_required",
                "Closing an item says why: give a reason code.",
                {
                  field: "reasonCode",
                },
              );
            }
          }
        } else {
          return refusal(
            "conflict",
            to === "open" ? (from === "open" ? "not_proposed" : "not_closed") : "already_closed",
            `This item is ${from}, so it cannot move to ${to} this way.`,
            { current: from },
          );
        }
        if (!mayMove(actor.role, move)) return forbidden(actor, move);
        if (actor.role === "system" && move === "accept" && rule === undefined) {
          return refusal(
            "forbidden",
            "rule_required",
            "The runtime accepts only under the owner's policy.",
          );
        }
        if (opts.supersededBy !== undefined) {
          if (opts.supersededBy === wi || !fold.items.has(opts.supersededBy)) {
            return refusal(
              "invalid",
              "invalid_field",
              "supersededBy names another work item of this harness.",
              {
                field: "supersededBy",
              },
            );
          }
        }
        let revision: WorkRevision | undefined;
        if (opts.note !== undefined) {
          const current = readRevision(wi, item.rev);
          if (current === undefined) {
            return refusal(
              "unavailable",
              "content_unreadable",
              "The item's content could not be read.",
            );
          }
          const origin = originOfRole(actor.role);
          revision = {
            ...current,
            rev: item.rev + 1,
            at: stampNow(),
            by: actor.by,
            notes: [
              ...(current.notes ?? []),
              { by: actor.by, at: stampNow(), text: opts.note, origin },
            ],
          };
        }
        return {
          ...(revision !== undefined ? { revision } : {}),
          line: line(
            {
              id: wi,
              state: to,
              event,
              ...(revision !== undefined ? { rev: revision.rev } : {}),
              ...(outcome !== undefined ? { outcome } : {}),
              ...(opts.reasonCode !== undefined ? { reasonCode: opts.reasonCode } : {}),
              ...(opts.supersededBy !== undefined ? { supersededBy: opts.supersededBy } : {}),
              ...(rule !== undefined ? { rule } : {}),
            },
            actor,
          ),
        };
      });
    },

    async link(wi, run, actor) {
      const bad =
        actorProblem(actor) ?? (mayMove(actor.role, "link") ? undefined : forbidden(actor, "link"));
      if (bad !== undefined) return bad;
      if (!CANONICAL_RUN_ID_RE.test(run)) {
        return refusal("invalid", "invalid_field", "A run is named by its canonical id (run_…).", {
          field: "run",
        });
      }
      return locked(wi, (item) => {
        // Already linked writes nothing, closed or not.
        if (item.runs.includes(run)) return {};
        if (item.state === "closed") {
          return refusal("conflict", "closed", "This item is closed; reopen it to link a run.", {
            current: item.state,
          });
        }
        return { line: line({ id: wi, state: item.state, event: "linked", run }, actor) };
      });
    },

    async rank(wi, order, actor) {
      const bad =
        actorProblem(actor) ?? (mayMove(actor.role, "rank") ? undefined : forbidden(actor, "rank"));
      if (bad !== undefined) return bad;
      if (!isId("wi", order.below) || order.below === wi) {
        return refusal("invalid", "invalid_field", "below names another work item.", {
          field: "below",
        });
      }
      if (!["item", "similar", "all"].includes(order.scope)) {
        return refusal("invalid", "invalid_field", "scope is item, similar or all.", {
          field: "scope",
        });
      }
      return locked(wi, (item, fold) => {
        const below = fold.items.get(order.below);
        if (below === undefined) {
          return refusal("not_found", "work_unknown", "There is no such item to move it above.");
        }
        if (item.state === "closed" || below.state === "closed") {
          return refusal("conflict", "closed", "A closed item is not ranked.", {
            current: item.state,
          });
        }
        return {
          line: line(
            { id: wi, state: item.state, event: "ranked", below: order.below, scope: order.scope },
            actor,
          ),
        };
      });
    },

    async deliver(wi, delivery, actor) {
      const bad =
        actorProblem(actor) ??
        (mayMove(actor.role, "deliver") ? undefined : forbidden(actor, "deliver"));
      if (bad !== undefined) return bad;
      if (!["report", "answer", "artifact"].includes(delivery.kind)) {
        return refusal(
          "invalid",
          "invalid_field",
          "A delivery is a report, an answer or an artifact.",
          {
            field: "deliver.kind",
          },
        );
      }
      const p = textProblem("deliver.ref", delivery.ref, REF_MAX);
      if (p !== undefined) return p;
      return locked(wi, (item) => {
        const current = readRevision(wi, item.rev);
        if (current === undefined) {
          return refusal(
            "unavailable",
            "content_unreadable",
            "The item's content could not be read.",
          );
        }
        const added: WorkDelivery = {
          kind: delivery.kind,
          ref: delivery.ref,
          at: stampNow(),
          origin: originOfRole(actor.role),
        };
        const revision: WorkRevision = {
          ...current,
          rev: item.rev + 1,
          at: stampNow(),
          by: actor.by,
          delivered: [...(current.delivered ?? []), added],
        };
        return {
          revision,
          line: line(
            {
              id: wi,
              state: item.state,
              event: "delivered",
              rev: revision.rev,
              delivered: { kind: delivery.kind },
            },
            actor,
          ),
        };
      });
    },

    async adopt(source, read, actor) {
      const bad =
        actorProblem(actor) ??
        (mayMove(actor.role, "open") ? undefined : forbidden(actor, "adopt"));
      if (bad !== undefined) return bad;
      if (typeof source.ref !== "string" || source.ref === "" || source.ref.length > REF_MAX) {
        return refusal("invalid", "invalid_field", "The source is named by a short reference.", {
          field: "source",
        });
      }
      return openSourced(source.kind, source.ref, async (wi, digest) => {
        const text = await read();
        if ("ok" in text) return text;
        const input: WorkInput = {
          title: oneLine(text.title).slice(0, TITLE_MAX),
          ...(text.goal !== undefined && text.goal.trim() !== ""
            ? { goal: text.goal.slice(0, GOAL_MAX) }
            : {}),
          kind: text.kind ?? "request",
        };
        const problem = fieldsProblem(input);
        if (problem !== undefined) return problem;
        const adopted: WorkSource = {
          kind: source.kind,
          ref: source.ref,
          ...(text.url !== undefined ? { url: text.url } : {}),
        };
        return {
          revision: firstRevision(wi, input, adopted, actor, text.origin, undefined, text.excerpt),
          opened: openedLine(wi, "open", input, adopted, actor, digest),
        };
      });
    },

    get(wi) {
      if (!isId("wi", wi)) return refusal("invalid", "invalid_field", "A work item is named wi_….");
      const fold = foldWork(harnessDir);
      if (!fold.ok) return refusal("unavailable", "log_unreadable", fold.reason);
      const item = fold.items.get(wi);
      if (item === undefined) {
        return refusal("not_found", "work_unknown", "This harness has no such work item.");
      }
      const revision = readRevision(wi, item.rev);
      return revision === undefined
        ? { item, revision, unreadable: "The item's content could not be read." }
        : { item, revision };
    },

    list(opts = {}) {
      const fold = foldWork(harnessDir, opts.cap ?? WORK_READ_CAP);
      if (!fold.ok) return { items: [], truncated: true, anomalies: 0 };
      const items = [...fold.items.values()]
        .filter(
          (item) => opts.state === undefined || opts.state === "all" || item.state === opts.state,
        )
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      return { items, truncated: fold.truncated || fold.gaps > 0, anomalies: fold.anomalies };
    },

    fold(cap) {
      const fold = foldWork(harnessDir, cap);
      return fold.ok ? fold : refusal("unavailable", "log_unreadable", fold.reason);
    },

    revision: readRevision,
  };
  return store;
}
