/** Command receipts and the closed registry of command kinds. */
import { MODULES, type ModuleField } from "./areas/index.js";
import type { CommandKindDecl } from "./areas/types.js";
import type { CommandState } from "./machines.js";
import type { ReceiptVia } from "./refs.js";
import { deepFreeze } from "./util.js";

export type { CommandKindDecl } from "./areas/types.js";

type CommandKindRow = ModuleField<"commandKinds"> extends readonly (infer Row)[] ? Row : never;

export type CommandKindId = CommandKindRow extends { readonly id: infer I } ? I : never;

/** Every command kind, by the id of the operation that issues it. */
export const COMMAND_KINDS: Readonly<Record<CommandKindId, CommandKindDecl>> = deepFreeze(
  Object.fromEntries(
    MODULES.flatMap((module) => module.commandKinds).map((kind) => [kind.id, kind]),
  ) as Record<CommandKindId, CommandKindDecl>,
);

export type ReceiptExecutor = {
  readonly pid: number;
  readonly startedAt: string;
  readonly host: string;
  readonly head: "server" | "resident" | "cli";
};

export type ReceiptEffect = {
  readonly kind: string;
  readonly ref?: string;
  readonly status: "done" | "unknown" | "failed" | "skipped";
  readonly observed?: string;
  readonly note?: string;
};

export type ReceiptRetry = {
  readonly retryable: boolean;
  readonly afterMs?: number;
  readonly safety: "idempotent" | "reconcile-first" | "never";
};

/**
 * What a command did, persisted before it is acknowledged. It carries refs and
 * digests only: no arguments, no inputs, no secrets. `actor` is a stored actor,
 * never a raw `local:` id. "Accepted" is never "done".
 */
export type CommandReceipt = {
  readonly id: string;
  readonly v: 1;
  readonly kind: string;
  readonly target: string;
  readonly actor: string;
  readonly via: ReceiptVia;
  readonly dedupeRef?: string;
  readonly fingerprint: string;
  readonly state: CommandState;
  readonly acceptedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly executor?: ReceiptExecutor;
  readonly effects: readonly ReceiptEffect[];
  readonly outcome?: {
    readonly code: string;
    readonly message: string;
  };
  readonly retry: ReceiptRetry;
  readonly winner?: string;
};
