/**
 * A v1 command: persisted before it is acknowledged, through the control service's one
 * `commands.submit`, then answered with its receipt. 202 while it is still running, 200
 * once it has ended, and a replay of an `Idempotency-Key` answers the receipt it named.
 */
import { type CommandReceipt, IDEMPOTENT_REPLAYED_HEADER } from "@crewhaus/control-contract";
import {
  type InlineEffect,
  type LedgerChoice,
  type SubmitRequest,
  harnessOfTarget,
  nudge,
} from "@crewhaus/control-service";
import type { V1BodyAnswer, V1Context } from "./context";
import { V1Error } from "./errors";

const TERMINAL = new Set(["succeeded", "failed", "rejected", "cancelled"]);

export type Submitted<T> = {
  readonly receipt: CommandReceipt;
  /** The effect's value; absent on a replay or a dispatched command. */
  readonly value?: T;
  readonly replayed: boolean;
};

type CommandInput<T> = {
  readonly target?: string;
  readonly ledger: LedgerChoice;
  /** The harness directory a workspace-ledger command acts on (`SubmitRequest.onHarness`). */
  readonly onHarness?: string;
  readonly effect?: InlineEffect<T>;
  /** The kind, when it is not the operation's id. */
  readonly kind?: string;
};

function requestOf(ctx: V1Context, input: CommandInput<unknown>): SubmitRequest {
  return {
    kind: input.kind ?? ctx.op.id,
    ...(ctx.actor !== undefined ? { actor: ctx.actor } : {}),
    ...(ctx.actor !== undefined && ctx.credentialRef !== undefined
      ? { credentialRef: ctx.credentialRef }
      : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    ledger: input.ledger,
    ...(input.onHarness !== undefined ? { onHarness: input.onHarness } : {}),
    via: ctx.via,
    body: ctx.body,
    params: ctx.params,
    ...(ctx.op.secretFields !== undefined ? { secretFields: ctx.op.secretFields } : {}),
    ...(ctx.idempotency !== undefined ? { idempotency: ctx.idempotency } : {}),
  };
}

function refusalOf(refusal: { readonly code: string; readonly message: string }): V1Error {
  const { code, message } = refusal;
  return new V1Error({
    status: code === "idempotency_key_reused" ? 422 : code === "invalid" ? 400 : 503,
    code,
    reason: code,
    message,
  });
}

/**
 * The command a repeated `Idempotency-Key` names, read before the command is planned:
 * its first receipt, so a retry is answered with what it repeats and never with a refusal
 * decided now. Throws 422 when the key named a different request; `undefined` when the
 * request carries no key, or its key is fresh. Writes nothing.
 */
export async function replayedCommand(
  ctx: V1Context,
  input: Omit<CommandInput<unknown>, "effect">,
): Promise<Submitted<never> | undefined> {
  if (ctx.idempotency === undefined) return undefined;
  const found = await ctx.deps.control.commands.replayOf(requestOf(ctx, input));
  if (found === undefined) return undefined;
  if (found.kind === "reused") throw refusalOf(found.refusal);
  return { receipt: found.receipt, replayed: true };
}

/** Submit the operation's own command kind. Refusals before acceptance answer v1 errors. */
export async function submitCommand<T>(
  ctx: V1Context,
  input: CommandInput<T>,
): Promise<Submitted<T>> {
  const answer = await ctx.deps.control.commands.submit<T>(requestOf(ctx, input), input.effect);
  if (!answer.ok) throw refusalOf(answer.refusal);
  // The read models of the harness it names are brought up to date first on the next pass.
  const harness = harnessOfTarget(answer.receipt.target);
  if (harness !== undefined) nudge("overview", harness);
  return answer.replayed
    ? { receipt: answer.receipt, replayed: true }
    : {
        receipt: answer.receipt,
        replayed: false,
        ...(answer.value !== undefined ? { value: answer.value as T } : {}),
      };
}

/** `commandAccepted`: the receipt, and anything the operation adds beside it. */
export function acceptedAnswer(
  submitted: Submitted<unknown>,
  extra: Readonly<Record<string, unknown>> = {},
  scrubDir?: string,
): V1BodyAnswer {
  return {
    status: TERMINAL.has(submitted.receipt.state) ? 200 : 202,
    body: { ...extra, receipt: submitted.receipt },
    ...(submitted.replayed ? { headers: { [IDEMPOTENT_REPLAYED_HEADER]: "true" } } : {}),
    ...(scrubDir !== undefined ? { scrubDir } : {}),
  };
}
