/**
 * The operator controls: pause, resume, disable and enable, as commands that write the
 * harness's operator record (`.crewhaus/run/control/operator.json`). The control service is
 * the record's only writer: the CLI's `crewhaus daemon pause|resume|disable|enable` runs
 * {@link applyOperatorControl} as its inline effect, and recovery runs the same function as
 * the kind's executor.
 *
 * Writing the record is the effect, so the receipt settles `succeeded` once it is written.
 * Then the head asks a running daemon to read it now, and the receipt says what it saw:
 *
 * | Daemon | Effect |
 * |---|---|
 * | no live runfile | `skipped`, "applies when it starts" |
 * | reload answers 200 with this rev or a later one | `done`, `confirmed` |
 * | reload answers 404: a build without the route | `skipped`, "recorded, not enforced: rebuild to apply it" |
 * | a lower rev, no control port, no client, a refusal or a timeout | `unknown`, "applies within a second" |
 *
 * The last row is true: every door a daemon has reads the record through a one-second cache.
 *
 * A receipt keeps no argument, so a pause run again by recovery cannot know it was quiet:
 * when the record already carries the receipt's id it is left as it is, and otherwise the
 * pause is written with the standard notice and the receipt says so.
 */
import type { CommandReceipt, ReceiptEffect } from "@crewhaus/control-contract";
import {
  type LeaseProbe,
  type OperatorDeployment,
  type OperatorIntake,
  type OperatorRecord,
  readOperatorRecord,
  writeOperatorRecord,
} from "@crewhaus/control-records";
import { readRunfile } from "@crewhaus/harness-supervisor";
import type { Executor, Reconciler, Settlement } from "./executor";
import { outcomeOf } from "./refusal";

export const OPERATOR_CONTROL_KINDS = [
  "controls.pause",
  "controls.resume",
  "controls.disable",
  "controls.enable",
] as const;

export type OperatorControlKind = (typeof OPERATOR_CONTROL_KINDS)[number];

export function isOperatorControlKind(kind: string): kind is OperatorControlKind {
  return (OPERATOR_CONTROL_KINDS as readonly string[]).includes(kind);
}

/** Where a head reaches a daemon's control port. */
export type OperatorReloadTarget = {
  readonly harnessDir: string;
  readonly controlPort?: number;
};

/** What the head's control client `reload` answers, as far as this module reads it. */
export type OperatorReloadAnswer =
  | {
      readonly ok: true;
      readonly body: { readonly operator?: { readonly rev?: number | null } } | undefined;
    }
  | { readonly ok: false; readonly code: string };

/** The head's control client call: `POST /control/v1/operator/reload`. */
export type OperatorReload = (target: OperatorReloadTarget) => Promise<OperatorReloadAnswer>;

export type OperatorControlContext = {
  readonly receipt: CommandReceipt;
  readonly harnessDir: string;
  readonly now: () => number;
  /** Asked whether a recorded daemon is alive; without it a runfile counts as live. */
  readonly probe?: LeaseProbe;
};

export type OperatorControlRequest = {
  readonly kind: OperatorControlKind;
  /** A pause shows no notice in channels: `notice: null`. */
  readonly quiet?: boolean;
  /** The head's control client call. Absent (an executor has none): `unknown`. */
  readonly reload?: OperatorReload;
  /** Run again by recovery, which cannot know the request's arguments. */
  readonly recovered?: boolean;
};

/** What the daemon made of the record, as a person reads it. */
export type OperatorDaemonAnswer = "confirmed" | "within-a-second" | "not-running" | "not-enforced";

export type OperatorControlAnswer = {
  readonly settle: Settlement;
  /** One line for a person, naming the writer's reason when the record was not written. */
  readonly line: string;
  /** The record as written; absent when nothing was written. */
  readonly record?: OperatorRecord;
  readonly daemon?: OperatorDaemonAnswer;
};

const DONE: Readonly<Record<OperatorControlKind, string>> = {
  "controls.pause": "Paused new work",
  "controls.resume": "Resumed new work",
  "controls.disable": "Disabled",
  "controls.enable": "Enabled",
};

const FEATURE: Readonly<Record<OperatorControlKind, string>> = {
  "controls.pause": "pause",
  "controls.resume": "pause",
  "controls.disable": "disable",
  "controls.enable": "disable",
};

const RECOVERED_NOTE = "recovered: written with the standard notice";

/** The block a kind writes: `intake` for pause and resume, `deployment` for the others. */
function blockOf(kind: OperatorControlKind): "intake" | "deployment" {
  return kind === "controls.pause" || kind === "controls.resume" ? "intake" : "deployment";
}

/** The line a person reads for what the daemon made of the record. */
export function operatorControlLine(
  kind: OperatorControlKind,
  daemon: OperatorDaemonAnswer,
): string {
  switch (daemon) {
    case "confirmed":
      return `${DONE[kind]}; the daemon confirmed`;
    case "within-a-second":
      return `${DONE[kind]}; the daemon applies it within a second`;
    case "not-running":
      return "Recorded; the daemon isn't running and applies it when it starts";
    case "not-enforced":
      return `Recorded, not enforced: this build predates ${FEATURE[kind]}. Recompile to apply it.`;
  }
}

function changeFor(
  kind: OperatorControlKind,
  fields: { readonly since: string; readonly by: string; readonly cmd: string },
  quiet: boolean,
): { readonly intake: OperatorIntake } | { readonly deployment: OperatorDeployment } {
  switch (kind) {
    case "controls.pause":
      // An absent `notice` is the fixed text; `null` is a quiet pause.
      return { intake: { paused: true, ...fields, ...(quiet ? { notice: null } : {}) } };
    case "controls.resume":
      // Kept, not cleared, so a reconciler can see whose resume it was.
      return { intake: { paused: false, ...fields } };
    case "controls.disable":
      return { deployment: { disabled: true, ...fields } };
    case "controls.enable":
      return { deployment: { disabled: false, ...fields } };
  }
}

const knownPort = (port: number | undefined): number | undefined =>
  port !== undefined && Number.isInteger(port) && port > 0 ? port : undefined;

/** What a running daemon made of record `rev`, as a receipt effect. */
async function daemonEffect(
  ctx: OperatorControlContext,
  rev: number,
  reload: OperatorReload | undefined,
): Promise<{ readonly effect: ReceiptEffect; readonly answer: OperatorDaemonAnswer }> {
  const notRunning = {
    effect: { kind: "daemon", status: "skipped", note: "applies when it starts" },
    answer: "not-running",
  } as const;
  const soon = {
    effect: { kind: "daemon", status: "unknown", note: "applies within a second" },
    answer: "within-a-second",
  } as const;
  const runfile = readRunfile(ctx.harnessDir);
  if (runfile === undefined) return notRunning;
  if (ctx.probe?.isAlive(runfile.pid) === false) return notRunning;
  const controlPort = knownPort(runfile.controlPort);
  if (reload === undefined || controlPort === undefined) return soon;
  let answer: OperatorReloadAnswer;
  try {
    answer = await reload({ harnessDir: ctx.harnessDir, controlPort });
  } catch {
    return soon;
  }
  if (answer.ok) {
    const seen = answer.body?.operator?.rev;
    return typeof seen === "number" && seen >= rev
      ? { effect: { kind: "daemon", status: "done", observed: "confirmed" }, answer: "confirmed" }
      : soon;
  }
  if (answer.code === "unsupported_by_bundle") {
    return {
      effect: {
        kind: "daemon",
        status: "skipped",
        note: "recorded, not enforced: rebuild to apply it",
      },
      answer: "not-enforced",
    };
  }
  return soon;
}

/**
 * Write the operator record for one control, then ask a running daemon to read it.
 * The record write is the effect: written, the receipt is `succeeded`; refused, it is
 * `failed` with `unavailable`, and the writer's reason is in the line, never the receipt.
 * The block's `by` is the receipt's stored actor and `since` the injected clock.
 *
 * First consumers: `crewhaus daemon pause|resume|disable|enable` (the inline effect) and
 * the four kinds' executors.
 */
export async function applyOperatorControl(
  ctx: OperatorControlContext,
  request: OperatorControlRequest,
): Promise<OperatorControlAnswer> {
  const { receipt } = ctx;
  const { kind } = request;
  const block = blockOf(kind);
  const recovered = request.recovered === true;
  if (recovered) {
    // Already written by the run that died: settle without a second write.
    const read = readOperatorRecord.refresh(ctx.harnessDir);
    if (read.state === "present" && read.record[block]?.cmd === receipt.id) {
      const { effect, answer } = await daemonEffect(ctx, read.record.rev, request.reload);
      return {
        settle: {
          state: "succeeded",
          effects: [
            { kind: "operator", status: "done", observed: `rev ${read.record.rev}` },
            effect,
          ],
        },
        line: operatorControlLine(kind, answer),
        record: read.record,
        daemon: answer,
      };
    }
  }
  const fields = {
    since: new Date(ctx.now()).toISOString(),
    by: receipt.actor,
    cmd: receipt.id,
  };
  const written = await writeOperatorRecord(
    ctx.harnessDir,
    changeFor(kind, fields, request.quiet === true && !recovered),
  );
  if (!written.ok) {
    return {
      settle: {
        state: "failed",
        effects: [{ kind: "operator", status: "failed" }],
        outcome: outcomeOf("unavailable"),
      },
      line: `Not changed: ${written.reason}`,
    };
  }
  const { rev } = written.record;
  const { effect, answer } = await daemonEffect(ctx, rev, request.reload);
  return {
    settle: {
      state: "succeeded",
      effects: [
        {
          kind: "operator",
          status: "done",
          observed: `rev ${rev}`,
          ...(recovered && kind === "controls.pause" ? { note: RECOVERED_NOTE } : {}),
        },
        effect,
      ],
    },
    line: operatorControlLine(kind, answer),
    record: written.record,
    daemon: answer,
  };
}

/** The executor for one control: the same write, as recovery runs it, with no client. */
function operatorExecutor(kind: OperatorControlKind): Executor {
  return async ({ receipt, harnessDir, now, probe }) =>
    (
      await applyOperatorControl(
        { receipt, harnessDir, now, ...(probe !== undefined ? { probe } : {}) },
        { kind, recovered: true },
      )
    ).settle;
}

/**
 * Did this control land? The block its kind writes names this receipt: `done`; a readable
 * record names another command (or there is none): `not-done`; unreadable, or a harness
 * with no live directory: `unknown`.
 */
export const reconcileOperatorControl: Reconciler = (receipt, ctx) => {
  if (!isOperatorControlKind(receipt.kind) || ctx.harnessDir === undefined) return "unknown";
  const read = readOperatorRecord.refresh(ctx.harnessDir);
  if (read.state === "unreadable") return "unknown";
  if (read.state === "absent") return "not-done";
  return read.record[blockOf(receipt.kind)]?.cmd === receipt.id ? "done" : "not-done";
};

export const OPERATOR_EXECUTORS: Readonly<Record<OperatorControlKind, Executor>> = {
  "controls.pause": operatorExecutor("controls.pause"),
  "controls.resume": operatorExecutor("controls.resume"),
  "controls.disable": operatorExecutor("controls.disable"),
  "controls.enable": operatorExecutor("controls.enable"),
};

export const OPERATOR_RECONCILERS: Readonly<Record<OperatorControlKind, Reconciler>> = {
  "controls.pause": reconcileOperatorControl,
  "controls.resume": reconcileOperatorControl,
  "controls.disable": reconcileOperatorControl,
  "controls.enable": reconcileOperatorControl,
};

/**
 * Record whether the harness should be running, for the recovery that runs after a
 * reboot: `writeOperatorRecord(dir, {desired})`. Both heads lend it to their supervisors.
 *
 * First consumers: the CLI's and Home's supervisors, and `crewhaus daemon stop|drain` of a
 * harness that is not running.
 */
export async function recordDesired(
  harnessDir: string,
  desired: "running" | "stopped",
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  const written = await writeOperatorRecord(harnessDir, { desired });
  return written.ok ? { ok: true } : { ok: false, reason: written.reason };
}
