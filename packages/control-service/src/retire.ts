/**
 * Retire's own steps: what ends everything a harness could still do, and what records
 * that it was retired. `crewhaus retire` runs them around the backup and the archive
 * (harness-lifecycle's `runRetirement`):
 *
 *   1. stop the daemon (only with `--stop`, through the head's own stop, which adopts it
 *      first and records `desired: "stopped"`), then disable the harness;
 *   2. cancel every queued run, taking the run's claim first, as the managed follower
 *      does, so a run a follower already claimed is never cancelled under it;
 *   3. expire every pending tool approval and unspent grant with reason `retired`; a
 *      pending `dec_` decision with no expire writer is listed for a person;
 *   4. revoke every active standing rule;
 *   5. run each area's retire revoker;
 *   6. (the archive, which moves the operator record away with the rest of the state)
 *      then disable the harness again in its live directory, so nothing starts it there;
 *   7. append `harness.retired` to Home's lifecycle record (`<hangarRoot>/control/
 *      lifecycle.jsonl`);
 *   8. mark the harness's registry row archived.
 *
 * Step 6 is the archive itself and the disable that follows it. Each step answers an outcome for the retirement log and
 * one receipt effect for the `controls.retire` receipt, which lives in Home's ledger: the
 * harness's own ledger moves into the archive with its state.
 */
import { join } from "node:path";
import type { CommandReceipt, ReceiptEffect } from "@crewhaus/control-contract";
import {
  type LeaseProbe,
  type Ledger,
  append,
  foldStates,
  proposalState,
  publishClaim,
  readProposals,
  readStandingRules,
  readTail,
  runsLedger,
  withLedgerLock,
  writeOperatorRecord,
} from "@crewhaus/control-records";
import { expireOpenApprovals } from "@crewhaus/session-store";
import type { Reconciler, RetireRevoker } from "./executor";
import { applyOperatorControl } from "./operator-controls";
import { revokeStandingRule } from "./rules";

/** Home's lifecycle record, relative to its root. */
export const LIFECYCLE_FILE = join("control", "lifecycle.jsonl");

/** Home's lifecycle record: one line per harness lifecycle event, under Home's control lock. */
export function lifecycleLedger(hangarRoot: string): Ledger {
  return {
    root: hangarRoot,
    records: { file: LIFECYCLE_FILE },
    lock: join("control", "lock"),
    claims: join("control", "claims"),
  };
}

/** One step's outcome, as harness-lifecycle's retirement log records it. */
export type RetireStepOutcome = {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
};

/** The registry write retire needs: harness-registry's `archive`. */
export type RetireRegistry = {
  archive(
    dirOrId: string,
    stamp: { readonly at: string; readonly by: string; readonly cmd: string },
  ): unknown;
};

export type RetireStepsOptions = {
  readonly harnessDir: string;
  /** The harness's `hrn_` id, when it has one. */
  readonly harnessId?: string;
  readonly hangarRoot: string;
  /** The `controls.retire` receipt: its stored actor and id go on every record written. */
  readonly receipt: CommandReceipt;
  /** `--stop`: stop the daemon first, through `stopDaemon`. */
  readonly stop: boolean;
  /** The head's stop: adopt, then stop, recording `desired: "stopped"`. */
  readonly stopDaemon?: () => Promise<{ readonly ok: boolean; readonly detail: string }>;
  readonly now: () => number;
  readonly probe?: LeaseProbe;
  /** Every area's revokers, in composition order (`retireRevokers(AREA_RUNTIMES)`). */
  readonly revokers?: readonly RetireRevoker[];
  /** Where the harness's tool approvals are parked; its `.crewhaus/sessions` by default. */
  readonly sessionRoot?: string;
  readonly registry?: RetireRegistry;
  /** The holder a run claim records: this process. */
  readonly holder?: Readonly<Record<string, unknown>>;
};

export type RetireSteps = {
  stopAndDisable(): Promise<RetireStepOutcome>;
  cancelQueuedRuns(): Promise<RetireStepOutcome>;
  expireDecisions(): Promise<RetireStepOutcome>;
  revokeStandingRules(): Promise<RetireStepOutcome>;
  revokeConnections(): Promise<RetireStepOutcome>;
  keepDisabled(): Promise<RetireStepOutcome>;
  recordLifecycle(): Promise<RetireStepOutcome>;
  archiveRegistryRow(): Promise<RetireStepOutcome>;
  /** One receipt effect per step that ran, in the order they ran. */
  effects(): readonly ReceiptEffect[];
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The steps retire runs itself, for a harness and one `controls.retire` receipt.
 *
 * First consumer: `crewhaus retire`.
 */
export function retireSteps(options: RetireStepsOptions): RetireSteps {
  const { harnessDir, receipt } = options;
  const iso = (): string => new Date(options.now()).toISOString();
  const effects: ReceiptEffect[] = [];
  const effect = (e: ReceiptEffect): void => {
    effects.push(e);
  };
  const outcome = (step: string, ok: boolean, detail: string): RetireStepOutcome => ({
    step,
    ok,
    detail,
  });

  return {
    async stopAndDisable() {
      if (options.stop) {
        if (options.stopDaemon === undefined) {
          effect({ kind: "retire.stop", status: "failed" });
          return outcome("stopAndDisable", false, "no way to stop the daemon was given");
        }
        let stopped: { readonly ok: boolean; readonly detail: string };
        try {
          stopped = await options.stopDaemon();
        } catch (err) {
          stopped = { ok: false, detail: messageOf(err) };
        }
        effect({ kind: "retire.stop", status: stopped.ok ? "done" : "failed" });
        if (!stopped.ok) return outcome("stopAndDisable", false, stopped.detail);
      }
      const disabled = await applyOperatorControl(
        {
          receipt,
          harnessDir,
          now: options.now,
          ...(options.probe !== undefined ? { probe: options.probe } : {}),
        },
        { kind: "controls.disable" },
      );
      const rev = disabled.record?.rev;
      effect({
        kind: "retire.disable",
        status: disabled.settle.state === "succeeded" ? "done" : "failed",
        ...(rev !== undefined ? { observed: `rev ${rev}` } : {}),
      });
      return disabled.settle.state === "succeeded"
        ? outcome("stopAndDisable", true, `${options.stop ? "stopped and " : ""}disabled`)
        : outcome("stopAndDisable", false, disabled.line);
    },

    async cancelQueuedRuns() {
      const ledger = runsLedger(harnessDir);
      const fold = foldStates(ledger);
      if (!fold.ok) {
        if (fold.code === "not-found") {
          effect({ kind: "retire.runs", status: "done", observed: "0 cancelled" });
          return outcome("cancelQueuedRuns", true, "no queued runs");
        }
        effect({ kind: "retire.runs", status: "failed" });
        return outcome("cancelQueuedRuns", false, `the run ledger can't be read: ${fold.reason}`);
      }
      const holder = options.holder ?? { pid: process.pid };
      let cancelled = 0;
      const running: string[] = [];
      const failed: string[] = [];
      for (const object of fold.objects.values()) {
        if (object.state !== "queued") continue;
        // The managed follower's claim: whoever publishes it first owns the run.
        const claimed = publishClaim(ledger, `run/${object.id}`, holder);
        if (!claimed.ok) {
          if (claimed.code === "exists") running.push(object.id);
          else failed.push(`${object.id}: ${claimed.reason}`);
          continue;
        }
        const written = append(ledger, {
          id: object.id,
          state: "cancelled",
          at: iso(),
          by: receipt.actor,
          cmd: receipt.id,
          ...(typeof object.record["trigger"] === "string"
            ? { trigger: object.record["trigger"] }
            : {}),
          ...(typeof object.record["tenant"] === "string"
            ? { tenant: object.record["tenant"] }
            : {}),
        });
        if (written.ok) cancelled += 1;
        else failed.push(`${object.id}: ${written.reason}`);
      }
      const ok = running.length === 0 && failed.length === 0;
      effect({
        kind: "retire.runs",
        status: ok ? "done" : "failed",
        observed: `${cancelled} cancelled`,
        ...(running.length > 0 ? { note: "already running" } : {}),
      });
      if (ok) return outcome("cancelQueuedRuns", true, `${cancelled} queued run(s) cancelled`);
      return outcome(
        "cancelQueuedRuns",
        false,
        [...(running.length > 0 ? [`already running: ${running.join(", ")}`] : []), ...failed].join(
          "; ",
        ),
      );
    },

    async expireDecisions() {
      const root = options.sessionRoot ?? join(harnessDir, ".crewhaus", "sessions");
      let expired: readonly string[];
      try {
        ({ expired } = await expireOpenApprovals(root, {
          reason: "retired",
          now: () => new Date(options.now()),
        }));
      } catch (err) {
        effect({ kind: "retire.approvals", status: "failed" });
        return outcome("expireDecisions", false, messageOf(err));
      }
      const proposals = readProposals(harnessDir);
      const waiting =
        proposals.state === "present"
          ? proposals.rows.filter((row) => proposalState(row, options.now()) === "pending").length
          : 0;
      effect({ kind: "retire.approvals", status: "done", observed: `${expired.length} expired` });
      if (waiting > 0) {
        effect({
          kind: "retire.decisions",
          status: "skipped",
          observed: `${waiting} pending`,
          note: "manual",
        });
      }
      const unreadable =
        proposals.state === "unreadable" ? "; the decision records can't be read" : "";
      return outcome(
        "expireDecisions",
        true,
        `${expired.length} approval(s) expired${
          waiting > 0 ? `; ${waiting} pending decision(s) to close by hand` : ""
        }${unreadable}`,
      );
    },

    async revokeStandingRules() {
      const read = readStandingRules(harnessDir);
      if (read.state === "unreadable") {
        effect({ kind: "retire.rules", status: "failed" });
        return outcome("revokeStandingRules", false, read.reason);
      }
      const active = read.state === "present" ? read.rows.filter((r) => r.state === "active") : [];
      let revoked = 0;
      const failed: string[] = [];
      for (const rule of active) {
        const answer = await revokeStandingRule({
          harnessDir,
          id: rule.id,
          revokedBy: receipt.actor,
          now: options.now(),
        });
        if (answer.outcome === "revoked" || answer.outcome === "ended") revoked += 1;
        else if (answer.outcome === "unavailable") failed.push(`${rule.id}: ${answer.reason}`);
      }
      effect({
        kind: "retire.rules",
        status: failed.length === 0 ? "done" : "failed",
        observed: `${revoked} revoked`,
      });
      return failed.length === 0
        ? outcome("revokeStandingRules", true, `${revoked} standing rule(s) revoked`)
        : outcome("revokeStandingRules", false, failed.join("; "));
    },

    async revokeConnections() {
      const revokers = options.revokers ?? [];
      if (revokers.length === 0) {
        effect({ kind: "retire.connections", status: "skipped", note: "none registered" });
        return outcome(
          "revokeConnections",
          true,
          "none are registered here; revoke this harness's channel and service credentials where they were issued",
        );
      }
      const ctx = {
        harnessDir,
        ...(options.harnessId !== undefined ? { harnessId: options.harnessId } : {}),
        actor: receipt.actor,
        now: options.now(),
        cmd: receipt.id,
      };
      const failed: string[] = [];
      for (const revoker of revokers) {
        try {
          const done = await revoker.revoke(ctx);
          for (const e of done) effect(e);
          if (done.some((e) => e.status === "failed")) failed.push(revoker.name);
        } catch (err) {
          effect({ kind: `retire.${revoker.name}`, status: "failed" });
          failed.push(`${revoker.name}: ${messageOf(err)}`);
        }
      }
      return failed.length === 0
        ? outcome("revokeConnections", true, `${revokers.length} revoker(s) ran`)
        : outcome("revokeConnections", false, `failed: ${failed.join("; ")}`);
    },

    async keepDisabled() {
      // The archive moved the operator record with the rest of `.crewhaus`; the spec and
      // the bundle stay where they were, so the harness is disabled there again, under
      // the retire's own receipt.
      let written: { readonly ok: boolean; readonly rev?: number; readonly reason?: string };
      try {
        const answer = await writeOperatorRecord(harnessDir, {
          deployment: { disabled: true, since: iso(), by: receipt.actor, cmd: receipt.id },
          desired: "stopped",
        });
        written = answer.ok
          ? { ok: true, rev: answer.record.rev }
          : { ok: false, reason: answer.reason };
      } catch (err) {
        written = { ok: false, reason: messageOf(err) };
      }
      effect({
        kind: "retire.keep-disabled",
        status: written.ok ? "done" : "failed",
        ...(written.rev !== undefined ? { observed: `rev ${written.rev}` } : {}),
      });
      return written.ok
        ? outcome("keepDisabled", true, "disabled where it lives, so nothing starts it")
        : outcome(
            "keepDisabled",
            false,
            `${written.reason ?? "not written"}; run \`crewhaus daemon disable\` in its directory`,
          );
    },

    async recordLifecycle() {
      const line = {
        type: "harness.retired",
        harness: options.harnessId ?? null,
        at: iso(),
        by: receipt.actor,
        cmd: receipt.id,
      };
      let written: { readonly ok: boolean; readonly reason?: string };
      try {
        const answer = await withLedgerLock(lifecycleLedger(options.hangarRoot), (locked) =>
          locked(line),
        );
        written = answer.ok ? { ok: true } : { ok: false, reason: answer.reason };
      } catch (err) {
        written = { ok: false, reason: messageOf(err) };
      }
      effect({ kind: "retire.lifecycle", status: written.ok ? "done" : "failed" });
      return written.ok
        ? outcome("recordLifecycle", true, "harness.retired recorded in Home's lifecycle record")
        : outcome("recordLifecycle", false, written.reason ?? "not written");
    },

    async archiveRegistryRow() {
      const stamp = { at: iso(), by: receipt.actor, cmd: receipt.id };
      let row: unknown;
      try {
        const registry = options.registry;
        row =
          (options.harnessId !== undefined
            ? registry?.archive(options.harnessId, stamp)
            : undefined) ?? registry?.archive(harnessDir, stamp);
      } catch (err) {
        effect({ kind: "retire.registry", status: "failed" });
        return outcome("archiveRegistryRow", false, messageOf(err));
      }
      if (row === undefined) {
        effect({ kind: "retire.registry", status: "skipped", note: "not registered" });
        return outcome("archiveRegistryRow", true, "not registered in Home");
      }
      effect({ kind: "retire.registry", status: "done" });
      return outcome("archiveRegistryRow", true, "registry row archived");
    },

    effects: () => [...effects],
  };
}

/**
 * Did a retire happen? A `harness.retired` line naming the receipt in Home's lifecycle
 * record: `done`. Otherwise `unknown`: a retire that stopped part way is a person's to
 * judge, never one to run again.
 */
export const reconcileRetire: Reconciler = (receipt, ctx) => {
  if (ctx.hangarRoot === undefined) return "unknown";
  const read = readTail(ctx.hangarRoot, LIFECYCLE_FILE, {
    maxLines: 100_000,
    maxBytes: 32 * 1024 * 1024,
  });
  if (read.state !== "read") return "unknown";
  return read.records.some(
    (line) => line["type"] === "harness.retired" && line["cmd"] === receipt.id,
  )
    ? "done"
    : "unknown";
};
