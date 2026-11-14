/**
 * Commands: persist, then act. `submit` writes the `accepted` receipt before anything runs
 * or answers, then runs the effect it was handed (inline: `accepted` straight to a final
 * state) or dispatches to the kind's registered executor (`accepted → running → final`,
 * through a compare-and-set, so two executors never both run one command). A request
 * refused before acceptance writes nothing.
 *
 * A receipt holds ids, refs, keyed digests and states: never an argument, an input or a
 * secret. Every row is the whole receipt, so the fold's current row is the receipt.
 *
 * A dispatched command runs only while the credential that submitted it, or for a receipt
 * without one its actor, may still do it: before `accepted → running`, and before recovery
 * runs a `running` one again, that authority is checked again, so a command whose authority
 * was withdrawn in between settles `rejected` (`failed`, once it had started) and does not
 * run.
 */
import { mkdirSync } from "node:fs";
import {
  COMMAND_KINDS,
  type CommandReceipt,
  IDEMPOTENCY_VALUE_RE,
  RECEIPT_AUTHORITY_KINDS,
  type ReceiptAuthority,
  type ReceiptRetry,
  type ReceiptVia,
  isCommandKind,
  isId,
  mintId,
  parseActor,
  parseRef,
} from "@crewhaus/control-contract";
import {
  type Ledger,
  type LedgerRecord,
  appendClaim,
  casAppend,
  foldStates,
  readClaim,
  withLedgerLock,
} from "@crewhaus/control-records";
import { storedActorFor } from "./actor";
import type { ControlCore } from "./context";
import type { Settlement } from "./executor";
import {
  IDEMPOTENCY_TTL_MS,
  expireStaleClaim,
  fingerprintOf,
  idempotencyClaim,
} from "./idempotency";
import { type LedgerChoice, ensureLedgerKey, ledgerFor, readLedgerKey } from "./ledgers";
import { type ControlRefusal, outcomeOf, refuse } from "./refusal";

export type SubmitRequest = {
  /** A command kind, or `legacy.<route key>`. */
  readonly kind: string;
  /**
   * Who asked, as a principal `prn_…` (the signed-in caller) or one of the system actors
   * (`sys:ingress` for a receiver's verified delivery). Absent, the head's own OS user
   * stands in (the CLI in direct mode, or a Home with sign-in turned off).
   */
  readonly actor?: string;
  /**
   * The credential (`crd_…`) `actor` authenticated with, when it used one. A command
   * dispatched from its receipt, when it is submitted or recovered, is checked against
   * exactly it. Given only with `actor`.
   */
  readonly credentialRef?: string;
  /** The most specific ref the request names. Absent: the receipt itself, `home/cmd/<id>`. */
  readonly target?: string;
  readonly ledger: LedgerChoice;
  readonly via: ReceiptVia;
  /** What the request asks for: fingerprinted, never stored. */
  readonly body?: Readonly<Record<string, unknown>>;
  /** Path parameters beyond the target (a route's `:key`, `:name`): fingerprinted, never stored. */
  readonly params?: Readonly<Record<string, string>>;
  /** The request's query, as name and value pairs: fingerprinted, never stored. */
  readonly query?: readonly (readonly [string, string])[];
  /** Body fields that hold a secret; the fingerprint leaves them out. */
  readonly secretFields?: readonly string[];
  /** The `Idempotency-Key` value, when the caller sent one. */
  readonly idempotency?: string;
  /**
   * A claim name (`<kind>/<name>`) the head chose for a delivery that must be accepted
   * exactly once, in place of an idempotency key's: a receiver's delivery id. The first
   * request writes the receipt with the claim; every later one is answered as a replay.
   */
  readonly dedupeClaim?: string;
  /** Whether repeating is safe, for a legacy kind (a command kind declares its own). */
  readonly idempotent?: boolean;
  /** The command is carried out by a queued job, which moves the receipt. */
  readonly queued?: boolean;
  /**
   * The owner's rule a system actor acts under: copied onto the receipt and into its
   * fingerprint. Only a system actor carries one.
   */
  readonly authority?: ReceiptAuthority;
};

/** Whether a receipt's authority is one of the closed kinds, naming a rule at a revision. */
function authorityIsValid(authority: unknown): authority is ReceiptAuthority {
  if (typeof authority !== "object" || authority === null || Array.isArray(authority)) return false;
  const a = authority as Record<string, unknown>;
  return (
    Object.keys(a).every((key) => ["kind", "rule", "revision", "clause"].includes(key)) &&
    (RECEIPT_AUTHORITY_KINDS as readonly unknown[]).includes(a["kind"]) &&
    isId("rule", a["rule"]) &&
    Number.isSafeInteger(a["revision"]) &&
    (a["revision"] as number) >= 1 &&
    (a["clause"] === undefined || a["clause"] === "rollback")
  );
}

/** An inline effect: what it returns to the caller, and how the command ended. A missing
 *  `settle` leaves the receipt `accepted`, for work a job carries on. */
export type InlineEffect<T> = (
  receipt: CommandReceipt,
) => Promise<{ readonly settle?: Settlement; readonly value: T }>;

export type SubmitAnswer<T> =
  | {
      readonly ok: true;
      readonly replayed: false;
      readonly receipt: CommandReceipt;
      readonly value: T;
    }
  | { readonly ok: true; readonly replayed: true; readonly receipt: CommandReceipt }
  | { readonly ok: false; readonly refusal: ControlRefusal };

const BOOKKEEPING = new Set(["claim", "gen", "repaired"]);

/** A ledger row as a receipt: the ledger's own fields (`claim`, `gen`, `repaired`) left out. */
export function receiptOf(record: LedgerRecord): CommandReceipt {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    if (!BOOKKEEPING.has(name)) out[name] = value;
  }
  return out as CommandReceipt;
}

/** Whether repeating this kind after an unknown outcome is safe. */
export function kindIsIdempotent(kind: string, declared?: boolean): boolean {
  const decl = (COMMAND_KINDS as Readonly<Record<string, { readonly idempotent: boolean }>>)[kind];
  return decl !== undefined ? decl.idempotent : declared === true;
}

export function retryFor(idempotent: boolean): ReceiptRetry {
  return idempotent
    ? { retryable: true, safety: "idempotent" }
    : { retryable: true, safety: "reconcile-first" };
}

/** The final row a settlement makes of a receipt. */
export function settledRow(base: CommandReceipt, settle: Settlement, at: string): CommandReceipt {
  return {
    ...base,
    state: settle.state,
    endedAt: at,
    effects: settle.effects ?? base.effects,
    ...(settle.outcome !== undefined ? { outcome: settle.outcome } : {}),
  };
}

export type Commands = {
  submit<T = undefined>(
    request: SubmitRequest,
    effect?: InlineEffect<T>,
  ): Promise<SubmitAnswer<T | undefined>>;
  /** The receipt's current state, folded from the ledger. A pure read. */
  get(ledger: LedgerChoice | Ledger, id: string): CommandReceipt | undefined;
  /**
   * What `submit` would answer for a request whose idempotency key was already used,
   * without writing anything: the first receipt (`replay`), or `reused` when the key named
   * a different request. `undefined` when the request carries no key, or its key is
   * fresh (or older than the seven days a key is honoured). A head asks this before it
   * plans a command, so a retry is answered with the command it repeats, never with a
   * refusal decided now.
   */
  replayOf(request: SubmitRequest): Promise<ReplayLookup | undefined>;
};

/** What {@link Commands.replayOf} found for a key already used. */
export type ReplayLookup =
  | { readonly kind: "replay"; readonly receipt: CommandReceipt }
  | { readonly kind: "reused"; readonly refusal: ControlRefusal };

/** The internals recovery and the job adapter share. */
export type CommandsInternals = Commands & {
  ledgerOf(choice: LedgerChoice | Ledger): Ledger;
  /** Move `from` to `next` with a compare-and-set; the current receipt when it lost. */
  move(ledger: Ledger, from: string, next: CommandReceipt): Promise<CommandReceipt | undefined>;
  /** Run the kind's executor: `accepted → running` first when `from` is `accepted`. */
  dispatch(
    ledger: Ledger,
    receipt: CommandReceipt,
    harnessDir: string | undefined,
  ): Promise<CommandReceipt>;
};

/** What a request's fingerprint is made of. */
function fingerprintInputOf(request: SubmitRequest): Parameters<typeof fingerprintOf>[1] {
  return {
    kind: request.kind,
    target: request.target ?? "",
    ...(request.params !== undefined ? { params: request.params } : {}),
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.secretFields !== undefined ? { secretFields: request.secretFields } : {}),
    ...(request.authority !== undefined ? { authority: request.authority } : {}),
  };
}

/** The harness an idempotency key is scoped to: the target's, when it is a harness; else `home`. */
function harnessScopeOf(target: string | undefined): string {
  const parsed = target === undefined ? undefined : parseRef(target);
  return parsed !== undefined && !("error" in parsed) && parsed.kind === "harness"
    ? parsed.id
    : "home";
}

export function createCommands(core: ControlCore): CommandsInternals {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const ledgerOf = (choice: LedgerChoice | Ledger): Ledger =>
    typeof choice === "object" && "root" in choice ? choice : ledgerFor(choice, core.hangarRoot);

  const get = (choice: LedgerChoice | Ledger, id: string): CommandReceipt | undefined => {
    const fold = foldStates(ledgerOf(choice));
    if (!fold.ok) return undefined;
    const found = fold.objects.get(id);
    return found === undefined ? undefined : receiptOf(found.record);
  };

  const move = async (
    ledger: Ledger,
    from: string,
    next: CommandReceipt,
  ): Promise<CommandReceipt | undefined> => {
    try {
      const answer = await casAppend(ledger, next.id, from, next as unknown as LedgerRecord);
      if (!answer.ok) {
        core.warn(`control-service: ${next.id} could not move to ${next.state}: ${answer.reason}`);
        return undefined;
      }
      return answer.applied
        ? next
        : answer.current === null
          ? undefined
          : receiptOf(answer.current);
    } catch (err) {
      core.warn(
        `control-service: ${next.id} could not move to ${next.state}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  };

  const dispatch = async (
    ledger: Ledger,
    receipt: CommandReceipt,
    harnessDir: string | undefined,
  ): Promise<CommandReceipt> => {
    let running = receipt;
    if (receipt.state === "accepted") {
      if (core.actorRefused(receipt)) {
        const rejected = settledRow(
          receipt,
          { state: "rejected", outcome: outcomeOf("forbidden") },
          iso(core.now()),
        );
        return (await move(ledger, "accepted", rejected)) ?? receipt;
      }
      const next: CommandReceipt = {
        ...receipt,
        state: "running",
        startedAt: iso(core.now()),
        executor: core.selfExecutor(),
      };
      const claimed = await move(ledger, "accepted", next);
      // Another executor moved it first: it is that one's to finish.
      if (claimed !== next) return claimed ?? receipt;
      running = next;
    }
    const executor = core.executors.get(receipt.kind);
    const supervised = !core.unsupervised.has(receipt.kind);
    const supervisor =
      harnessDir !== undefined && supervised ? core.supervisorFor(harnessDir) : undefined;
    let settle: Settlement;
    if (
      executor === undefined ||
      harnessDir === undefined ||
      (supervised && supervisor === undefined)
    ) {
      settle = { state: "failed", outcome: outcomeOf("unavailable") };
    } else {
      try {
        settle = await executor({
          receipt: running,
          harnessDir,
          ...(supervisor !== undefined ? { supervisor } : {}),
          drainRequest: core.drainRequest(harnessDir),
          now: core.now,
          probe: core.probe,
        });
      } catch {
        settle = {
          state: kindIsIdempotent(receipt.kind) ? "failed" : "unknown",
          outcome: outcomeOf("internal"),
        };
      } finally {
        if (supervisor !== undefined) core.releaseSupervisor(harnessDir, supervisor);
      }
    }
    // `running → rejected` and `running → cancelled` are not moves the machine allows: a
    // refusal after the start is a failure of the dispatched run.
    const final: Settlement =
      settle.state === "rejected" || settle.state === "cancelled"
        ? { ...settle, state: "failed" }
        : settle;
    return (await move(ledger, "running", settledRow(running, final, iso(core.now())))) ?? running;
  };

  const submit = async <T>(
    request: SubmitRequest,
    effect?: InlineEffect<T>,
  ): Promise<SubmitAnswer<T | undefined>> => {
    if (!isCommandKind(request.kind)) {
      return { ok: false, refusal: refuse("invalid", `unknown command kind "${request.kind}"`) };
    }
    if (request.idempotency !== undefined && !IDEMPOTENCY_VALUE_RE.test(request.idempotency)) {
      return {
        ok: false,
        refusal: refuse("invalid", "an idempotency key is 1-128 of A-Z a-z 0-9 . _ : -"),
      };
    }
    if (request.dedupeClaim !== undefined && request.idempotency !== undefined) {
      return {
        ok: false,
        refusal: refuse(
          "invalid",
          "a command takes an idempotency key or a delivery claim, not both",
        ),
      };
    }
    if (request.target !== undefined && "error" in parseRef(request.target)) {
      return { ok: false, refusal: refuse("invalid", "the command's target is not a ref") };
    }
    if (
      request.actor !== undefined &&
      !isId("prn", request.actor) &&
      parseActor(request.actor)?.form !== "system"
    ) {
      return {
        ok: false,
        refusal: refuse("invalid", "the command's actor is not a principal or a system actor"),
      };
    }
    if (request.authority !== undefined) {
      if (!authorityIsValid(request.authority)) {
        return { ok: false, refusal: refuse("invalid", "the command's authority is not a rule") };
      }
      if (request.actor === undefined || parseActor(request.actor)?.form !== "system") {
        return {
          ok: false,
          refusal: refuse("invalid", "only a system actor acts under a rule's authority"),
        };
      }
    }
    if (request.credentialRef !== undefined) {
      if (!isId("crd", request.credentialRef)) {
        return { ok: false, refusal: refuse("invalid", "the command's credential is not one") };
      }
      if (request.actor === undefined) {
        return {
          ok: false,
          refusal: refuse("invalid", "a command's credential is given with its actor"),
        };
      }
    }
    const ledger = ledgerOf(request.ledger);
    if (request.ledger === "workspace") {
      try {
        mkdirSync(core.hangarRoot, { recursive: true, mode: 0o700 });
      } catch {
        return { ok: false, refusal: refuse("unavailable", "Home's directory cannot be created") };
      }
    }
    const key = await ensureLedgerKey(request.ledger, core.hangarRoot);
    if (key.state !== "present") {
      return {
        ok: false,
        refusal: refuse("unavailable", "the ledger's digest key cannot be read; nothing was done"),
      };
    }
    const actor = request.actor ?? (await storedActorFor(core.hangarRoot, core.identity, key.hmac));
    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(key.hmac, fingerprintInputOf(request));
    } catch {
      return { ok: false, refusal: refuse("invalid", "the request body cannot be fingerprinted") };
    }
    const now = core.now();
    const id = mintId("cmd", { now });
    const idempotent = kindIsIdempotent(request.kind, request.idempotent);
    const harnessScope = harnessScopeOf(request.target);
    const dedupeRef =
      request.dedupeClaim ??
      (request.idempotency === undefined
        ? undefined
        : idempotencyClaim(
            { actor, harness: harnessScope, kind: request.kind },
            request.idempotency,
          ));
    const accepted: CommandReceipt = {
      id,
      v: 1,
      kind: request.kind,
      target: request.target ?? `home/cmd/${id}`,
      actor,
      ...(request.credentialRef !== undefined ? { credentialRef: request.credentialRef } : {}),
      via: request.via,
      ...(dedupeRef !== undefined ? { dedupeRef } : {}),
      fingerprint,
      state: "accepted",
      acceptedAt: iso(now),
      executor: core.selfExecutor(),
      effects: request.queued === true ? [{ kind: "job", status: "unknown" }] : [],
      retry: retryFor(idempotent),
      ...(request.authority !== undefined ? { authority: request.authority } : {}),
    };

    try {
      if (dedupeRef !== undefined) {
        await expireStaleClaim(ledger, dedupeRef, now);
        const claimed = await appendClaim(ledger, {
          claim: dedupeRef,
          record: accepted as unknown as LedgerRecord,
        });
        if (!claimed.ok) {
          return { ok: false, refusal: refuse("unavailable", "the receipt could not be written") };
        }
        if (!claimed.won) {
          const winner = claimed.winner.record;
          if (winner["fingerprint"] !== fingerprint || winner["kind"] !== request.kind) {
            return {
              ok: false,
              refusal: refuse(
                "idempotency_key_reused",
                "this idempotency key was used for a different request",
              ),
            };
          }
          const winnerId = String(winner["id"]);
          return {
            ok: true,
            replayed: true,
            receipt: get(ledger, winnerId) ?? receiptOf(winner),
          };
        }
      } else {
        const written = await withLedgerLock(ledger, (lockedAppend) =>
          lockedAppend(accepted as unknown as LedgerRecord),
        );
        if (!written.ok) {
          return { ok: false, refusal: refuse("unavailable", "the receipt could not be written") };
        }
      }
    } catch {
      return { ok: false, refusal: refuse("unavailable", "the receipt could not be written") };
    }

    // Persisted. Everything from here on is answered with the receipt.
    if (effect !== undefined) {
      const startedAt = iso(core.now());
      let outcome: { readonly settle?: Settlement; readonly value: T };
      try {
        outcome = await effect(accepted);
      } catch (err) {
        await move(
          ledger,
          "accepted",
          settledRow(
            { ...accepted, startedAt },
            { state: idempotent ? "failed" : "unknown", outcome: outcomeOf("internal") },
            iso(core.now()),
          ),
        );
        throw err;
      }
      if (outcome.settle === undefined) {
        return {
          ok: true,
          replayed: false,
          receipt: get(ledger, id) ?? accepted,
          value: outcome.value,
        };
      }
      const final =
        (await move(
          ledger,
          "accepted",
          settledRow({ ...accepted, startedAt }, outcome.settle, iso(core.now())),
        )) ?? accepted;
      return { ok: true, replayed: false, receipt: final, value: outcome.value };
    }
    if (request.queued !== true && core.executors.has(request.kind)) {
      const harnessDir =
        request.ledger === "workspace"
          ? harnessDirOfTarget(core, accepted.target)
          : request.ledger.harness;
      const final = await dispatch(ledger, accepted, harnessDir);
      return { ok: true, replayed: false, receipt: final, value: undefined };
    }
    return { ok: true, replayed: false, receipt: accepted, value: undefined };
  };

  const replayOf = async (request: SubmitRequest): Promise<ReplayLookup | undefined> => {
    if (request.idempotency === undefined || !isCommandKind(request.kind)) return undefined;
    if (!IDEMPOTENCY_VALUE_RE.test(request.idempotency)) return undefined;
    if (request.target !== undefined && "error" in parseRef(request.target)) return undefined;
    // No key yet: nothing was ever claimed in this ledger.
    const key = await readLedgerKey(request.ledger, core.hangarRoot);
    if (key.state !== "present") return undefined;
    const actor = request.actor ?? (await storedActorFor(core.hangarRoot, core.identity, key.hmac));
    const claim = idempotencyClaim(
      { actor, harness: harnessScopeOf(request.target), kind: request.kind },
      request.idempotency,
    );
    const ledger = ledgerOf(request.ledger);
    const read = readClaim(ledger, claim);
    if (!read.ok) return undefined;
    const claimedAt = Date.parse(read.content.at);
    if (Number.isFinite(claimedAt) && claimedAt < core.now() - IDEMPOTENCY_TTL_MS) return undefined;
    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(key.hmac, fingerprintInputOf(request));
    } catch {
      return undefined;
    }
    const winner = read.content.record;
    if (winner["fingerprint"] !== fingerprint || winner["kind"] !== request.kind) {
      return {
        kind: "reused",
        refusal: refuse(
          "idempotency_key_reused",
          "this idempotency key was used for a different request",
        ),
      };
    }
    return { kind: "replay", receipt: get(ledger, String(winner["id"])) ?? receiptOf(winner) };
  };

  return { submit, get, ledgerOf, move, dispatch, replayOf };
}

/** The live directory of the harness a target names, when it names a registered one. */
export function harnessDirOfTarget(core: ControlCore, target: string): string | undefined {
  const parsed = parseRef(target);
  if ("error" in parsed || parsed.kind !== "harness") return undefined;
  return core.harnessDirOf(parsed.id);
}
