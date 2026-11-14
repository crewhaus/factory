/** Command receipts and the closed registry of command kinds. */
import type { ReceiptAuthorityKind } from "./areas/delegation.js";
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

/**
 * A receipt kind for a legacy Hangar route, or a CLI verb, that has no core kind of its
 * own: `legacy.<key>`. The closed list of them is a legacy route's key (Home's route
 * table) or a CLI verb with no core kind of its own (`hangarInstall`, `hangarUninstall`);
 * no executor is ever registered for one, so recovery never runs one again.
 */
export const LEGACY_COMMAND_KIND_RE = /^legacy\.[a-z][A-Za-z0-9]{0,63}$/;

/** Whether `kind` may name a receipt: a composed command kind, or a legacy route's. */
export function isCommandKind(kind: unknown): kind is string {
  return (
    typeof kind === "string" &&
    (Object.hasOwn(COMMAND_KINDS, kind) || LEGACY_COMMAND_KIND_RE.test(kind))
  );
}

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
 * Whose standing authority a command ran under, beside its actor: an owner's delegation
 * rule (or an assistant rule) at one revision. `clause: "rollback"` marks the rule's
 * rollback clause, which outlives a pause or a revoke of the rule.
 */
export type ReceiptAuthority = {
  readonly kind: ReceiptAuthorityKind;
  readonly rule: string;
  readonly revision: number;
  readonly clause?: "rollback";
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
  /** The rule a system actor acted under. Absent: the actor's own authority. */
  readonly authority?: ReceiptAuthority;
};
