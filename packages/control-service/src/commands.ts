/**
 * Commands: persist, then act. `submit` writes the `accepted` receipt before anything runs
 * or answers, then runs the effect it was handed (inline: `accepted` straight to a final
 * state) or dispatches to the kind's registered executor (`accepted → running → final`,
 * through a compare-and-set, so two executors never both run one command). A request
 * refused before acceptance writes nothing.
 *
 * A receipt holds ids, refs, keyed digests and states: never an argument, an input or a
 * secret. Every row is the whole receipt, so the fold's current row is the receipt.
 */
import { mkdirSync } from "node:fs";
import {
  COMMAND_KINDS,
  type CommandReceipt,
  IDEMPOTENCY_VALUE_RE,
  type ReceiptRetry,
  type ReceiptVia,
  isCommandKind,
  mintId,
  parseRef,
} from "@crewhaus/control-contract";
import {
  type Ledger,
  type LedgerRecord,
  appendClaim,
  casAppend,
  foldStates,
  withLedgerLock,
} from "@crewhaus/control-records";
import { storedActorFor } from "./actor";
import type { ControlCore } from "./context";
import type { Settlement } from "./executor";
import { expireStaleClaim, fingerprintOf, idempotencyClaim } from "./idempotency";
import { type LedgerChoice, ensureLedgerKey, ledgerFor } from "./ledgers";
import { type ControlRefusal, outcomeOf, refuse } from "./refusal";

export type SubmitRequest = {
  /** A command kind, or `legacy.<route key>`. */
  readonly kind: string;
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
  /** Whether repeating is safe, for a legacy kind (a command kind declares its own). */
  readonly idempotent?: boolean;
  /** The command is carried out by a queued job, which moves the receipt. */
  readonly queued?: boolean;
};

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
};

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
    const supervisor = harnessDir !== undefined ? core.supervisorFor(harnessDir) : undefined;
    let settle: Settlement;
    if (executor === undefined || harnessDir === undefined || supervisor === undefined) {
      settle = { state: "failed", outcome: outcomeOf("unavailable") };
    } else {
      try {
        settle = await executor({
          receipt: running,
          harnessDir,
          supervisor,
          drainRequest: core.drainRequest(harnessDir),
          now: core.now,
        });
      } catch {
        settle = {
          state: kindIsIdempotent(receipt.kind) ? "failed" : "unknown",
          outcome: outcomeOf("internal"),
        };
      } finally {
        core.releaseSupervisor(harnessDir, supervisor);
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
    if (request.target !== undefined && "error" in parseRef(request.target)) {
      return { ok: false, refusal: refuse("invalid", "the command's target is not a ref") };
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
    const actor = await storedActorFor(core.hangarRoot, core.identity, key.hmac);
    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(key.hmac, {
        kind: request.kind,
        target: request.target ?? "",
        ...(request.params !== undefined ? { params: request.params } : {}),
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.secretFields !== undefined ? { secretFields: request.secretFields } : {}),
      });
    } catch {
      return { ok: false, refusal: refuse("invalid", "the request body cannot be fingerprinted") };
    }
    const now = core.now();
    const id = mintId("cmd", { now });
    const idempotent = kindIsIdempotent(request.kind, request.idempotent);
    const parsedTarget = request.target === undefined ? undefined : parseRef(request.target);
    const harnessScope =
      parsedTarget !== undefined && !("error" in parsedTarget) && parsedTarget.kind === "harness"
        ? parsedTarget.id
        : "home";
    const dedupeRef =
      request.idempotency === undefined
        ? undefined
        : idempotencyClaim(
            { actor, harness: harnessScope, kind: request.kind },
            request.idempotency,
          );
    const accepted: CommandReceipt = {
      id,
      v: 1,
      kind: request.kind,
      target: request.target ?? `home/cmd/${id}`,
      actor,
      via: request.via,
      ...(dedupeRef !== undefined ? { dedupeRef } : {}),
      fingerprint,
      state: "accepted",
      acceptedAt: iso(now),
      executor: core.selfExecutor(),
      effects: request.queued === true ? [{ kind: "job", status: "unknown" }] : [],
      retry: retryFor(idempotent),
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

  return { submit, get, ledgerOf, move, dispatch };
}

/** The live directory of the harness a target names, when it names a registered one. */
export function harnessDirOfTarget(core: ControlCore, target: string): string | undefined {
  const parsed = parseRef(target);
  if ("error" in parsed || parsed.kind !== "harness") return undefined;
  return core.harnessDirOf(parsed.id);
}
