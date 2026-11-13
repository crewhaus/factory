/**
 * The command receipt a CLI quality verb runs under: written to the harness's own
 * ledger before its effect runs, through the same control service Home uses (direct
 * mode, recovery first), the way `crewhaus deploy activate` writes its receipt. A receipt
 * that cannot be written means the effect does not run.
 */
import { type CommandReceipt, EXIT_FOR_ERROR, parseRef } from "@crewhaus/control-contract";
import {
  type ControlService,
  type Settlement,
  currentLocalIdentity,
  ensureHarnessIdentity,
  outcomeOf,
  wireControl,
  withOwnStartTime,
} from "@crewhaus/control-service";
import type { PinOutcome } from "@crewhaus/eval-report";
import { openHangarRegistry, resolveHangarRoot } from "@crewhaus/harness-registry";
import { createProcessOps } from "@crewhaus/harness-supervisor";

export type QualityReceiptOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
};

/** The control service in direct mode, for one harness's quality verbs. */
export function qualityControl(options: QualityReceiptOptions = {}): ControlService {
  const env = options.env ?? process.env;
  return wireControl(
    {
      hangarRoot: resolveHangarRoot(env),
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
      identity: currentLocalIdentity(),
      ...(options.now !== undefined ? { now: options.now } : {}),
      probe: withOwnStartTime(createProcessOps()),
    },
    { mode: "direct" },
  );
}

/** The harness's portable id, created on first use. */
export function harnessIdOf(
  harnessDir: string,
  options: QualityReceiptOptions = {},
): { ok: true; id: string } | { ok: false; reason: string } {
  let registryId: string | undefined;
  try {
    registryId = openHangarRegistry({ env: options.env ?? process.env }).get(harnessDir)?.id;
  } catch {
    registryId = undefined;
  }
  const identity = ensureHarnessIdentity(harnessDir, registryId);
  return identity.ok ? { ok: true, id: identity.id } : { ok: false, reason: identity.reason };
}

export type ReceiptedAnswer<T> =
  | {
      readonly ok: true;
      readonly receipt: CommandReceipt;
      /** Absent when the receipt was a replay of an earlier one. */
      readonly value?: T;
    }
  | { readonly ok: false; readonly reason: string; readonly exitCode: number };

/**
 * Run `effect` under a receipt of `kind` in the harness's own ledger. `target` is the
 * object's id under the harness (`evalrun/run_…`, `change/chg_…`), or absent for the
 * harness itself.
 */
export async function withQualityReceipt<T>(
  args: {
    readonly harnessDir: string;
    readonly kind: string;
    readonly target?: { readonly kind: string; readonly id: string };
    readonly body?: Readonly<Record<string, unknown>>;
    readonly control?: ControlService;
  } & QualityReceiptOptions,
  effect: (receipt: CommandReceipt) => Promise<{ readonly settle: Settlement; readonly value: T }>,
): Promise<ReceiptedAnswer<T>> {
  const identity = harnessIdOf(args.harnessDir, args);
  if (!identity.ok) {
    return {
      ok: false,
      reason: `harness.json can't be written: ${identity.reason}`,
      exitCode: EXIT_FOR_ERROR.unavailable,
    };
  }
  const control = args.control ?? qualityControl(args);
  try {
    await control.commands.recover({ harness: args.harnessDir });
  } catch {
    // Recovery is the writer's courtesy to the last crash, never a gate on this verb.
  }
  // The object's own ref when it parses as one; the harness otherwise.
  const objectRef =
    args.target !== undefined ? `${identity.id}/${args.target.kind}/${args.target.id}` : undefined;
  const target =
    objectRef !== undefined && !("error" in parseRef(objectRef))
      ? objectRef
      : `home/harness/${identity.id}`;
  const answer = await control.commands.submit<T>(
    {
      kind: args.kind,
      target,
      ledger: { harness: args.harnessDir },
      via: "cli",
      ...(args.body !== undefined ? { body: args.body } : {}),
    },
    effect,
  );
  if (!answer.ok) {
    return {
      ok: false,
      reason: answer.refusal.message,
      exitCode: EXIT_FOR_ERROR[answer.refusal.code],
    };
  }
  return answer.replayed
    ? { ok: true, receipt: answer.receipt }
    : {
        ok: true,
        receipt: answer.receipt,
        ...(answer.value !== undefined ? { value: answer.value } : {}),
      };
}

/** The local user as a stored actor in this harness's records. */
export async function localStoredActor(
  harnessDir: string,
  control: ControlService,
): Promise<string> {
  return control.decisions.storedActorOf(harnessDir, {
    kind: "local",
    identity: currentLocalIdentity(),
  });
}

/**
 * Pin under a receipt: `quality.baselines.rebaseline` for a re-anchor
 * (`crewhaus eval --rebaseline|--regrade-baseline`), `quality.baselines.pin` for a
 * person's pin (`crewhaus eval-report baseline set`). The pin runs only once the
 * receipt is written, and its mark names the receipt; a receipt that cannot be written
 * answers a `receipt` refusal, so the baseline is kept.
 */
export async function reanchorUnderReceipt(
  args: {
    readonly harnessDir: string;
    readonly runId: string;
    readonly reason?: string;
    readonly kind?: "quality.baselines.rebaseline" | "quality.baselines.pin";
    readonly pin: (receipt?: string) => PinOutcome;
  } & QualityReceiptOptions,
): Promise<PinOutcome> {
  const answer = await withQualityReceipt<PinOutcome>(
    {
      harnessDir: args.harnessDir,
      kind: args.kind ?? "quality.baselines.rebaseline",
      target: { kind: "evalrun", id: args.runId },
      ...(args.reason !== undefined ? { body: { reason: args.reason } } : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
      ...(args.now !== undefined ? { now: args.now } : {}),
    },
    async (receipt) => {
      const outcome = args.pin(receipt.id);
      return {
        settle: outcome.ok
          ? { state: "succeeded" }
          : { state: "rejected", outcome: outcomeOf("invalid") },
        value: outcome,
      };
    },
  );
  if (!answer.ok) {
    return {
      ok: false,
      refusal: {
        code: "receipt",
        reason: `the re-anchor's receipt could not be written (${answer.reason}), so the baseline was not changed`,
      },
    };
  }
  return (
    answer.value ?? {
      ok: false,
      refusal: { code: "receipt", reason: `${answer.receipt.id} already ran; nothing was pinned` },
    }
  );
}
