/**
 * A v1 command: persisted before it is acknowledged, through the control service's one
 * `commands.submit`, then answered with its receipt. 202 while it is still running, 200
 * once it has ended, and a replay of an `Idempotency-Key` answers the receipt it named.
 */
import { type CommandReceipt, IDEMPOTENT_REPLAYED_HEADER } from "@crewhaus/control-contract";
import type { InlineEffect, LedgerChoice } from "@crewhaus/control-service";
import type { V1Answer, V1Context } from "./context";
import { V1Error } from "./errors";

const TERMINAL = new Set(["succeeded", "failed", "rejected", "cancelled"]);

export type Submitted<T> = {
  readonly receipt: CommandReceipt;
  /** The effect's value; absent on a replay or a dispatched command. */
  readonly value?: T;
  readonly replayed: boolean;
};

/** Submit the operation's own command kind. Refusals before acceptance answer v1 errors. */
export async function submitCommand<T>(
  ctx: V1Context,
  input: {
    readonly target?: string;
    readonly ledger: LedgerChoice;
    readonly effect?: InlineEffect<T>;
    /** The kind, when it is not the operation's id. */
    readonly kind?: string;
  },
): Promise<Submitted<T>> {
  const answer = await ctx.deps.control.commands.submit<T>(
    {
      kind: input.kind ?? ctx.op.id,
      ...(ctx.actor !== undefined ? { actor: ctx.actor } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ledger: input.ledger,
      via: ctx.via,
      body: ctx.body,
      params: ctx.params,
      ...(ctx.op.secretFields !== undefined ? { secretFields: ctx.op.secretFields } : {}),
      ...(ctx.idempotency !== undefined ? { idempotency: ctx.idempotency } : {}),
    },
    input.effect,
  );
  if (!answer.ok) {
    const { code, message } = answer.refusal;
    throw new V1Error({
      status: code === "idempotency_key_reused" ? 422 : code === "invalid" ? 400 : 503,
      code,
      reason: code,
      message,
    });
  }
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
): V1Answer {
  return {
    status: TERMINAL.has(submitted.receipt.state) ? 200 : 202,
    body: { ...extra, receipt: submitted.receipt },
    ...(submitted.replayed ? { headers: { [IDEMPOTENT_REPLAYED_HEADER]: "true" } } : {}),
    ...(scrubDir !== undefined ? { scrubDir } : {}),
  };
}
