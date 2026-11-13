/**
 * `crewhaus retire` as a command: the liveness check, the receipt, and the steps that end
 * what the harness could still do. `index.ts`'s `runRetire` reads the spec registry and
 * wires the heavy steps (backup, evidence, audit, knowledge, tombstone); this module runs
 * the rest around them (#507, #513):
 *
 *   - a harness whose daemon runs is refused before anything happens, dry run included,
 *     unless `--stop`, which stops it (adopting it first) and records it stopped;
 *   - the harness is disabled, its queued runs cancelled, its open approvals expired, its
 *     standing rules revoked and every area's revoker run, before the backup;
 *   - after the archive, `harness.retired` is appended to Home's lifecycle record and the
 *     registry row is marked archived.
 *
 * The receipt is a `controls.retire` in Home's own ledger: the harness's ledger moves into
 * the archive with its state. A dry run writes no receipt, runs no recovery and changes
 * nothing.
 */
import { hostname } from "node:os";
import type { ReceiptEffect } from "@crewhaus/control-contract";
import {
  AREA_RUNTIMES,
  type RetireItem,
  outcomeOf,
  retireRevokers,
  retireSteps,
} from "@crewhaus/control-service";
import {
  RetireError,
  type RetirementSteps,
  buildRetirementPlan,
  formatPlan,
  formatRetirementResult,
  runRetirement,
} from "@crewhaus/harness-lifecycle/retire";
import { openHangarRegistry, resolveHangarRoot } from "@crewhaus/harness-registry";
import {
  createProcessOps,
  loadEnvChain,
  readRunfile,
  systemClock,
  verifyRunfile,
} from "@crewhaus/harness-supervisor";
import { resolveHarnessSessionRoot } from "@crewhaus/session-store";
import {
  type DaemonCommandOptions,
  type DaemonCommandResult,
  directControl,
  harnessIdOf,
  resolveHarness,
  supervisorFor,
} from "./daemon-cmd";

/** The steps `runRetire` wires itself, from the spec registry and the harness's files. */
export type HeavyRetireSteps = Pick<
  RetirementSteps,
  "backupState" | "complianceEvidence" | "auditVerify" | "pushKnowledge" | "tombstoneRegistry"
>;

export type RetireCommandOptions = {
  readonly harnessDir: string;
  /** The spec's registry name. */
  readonly specName: string;
  readonly archiveDir: string;
  readonly pins: Readonly<Record<string, string>>;
  readonly force: boolean;
  readonly pushKnowledge: boolean;
  readonly stop: boolean;
  readonly dryRun: boolean;
  readonly forceUnverified: boolean;
  readonly heavy: HeavyRetireSteps;
  /** The seams the daemon verbs take: env, process ops, clock, fetch, identity. */
  readonly opts?: DaemonCommandOptions;
};

/** Whether the harness's daemon is running now, by its runfile. Only reads. */
export function daemonIsLive(harnessDir: string, opts: DaemonCommandOptions = {}): boolean {
  const runfile = readRunfile(harnessDir);
  if (runfile === undefined) return false;
  return verifyRunfile(runfile, opts.ops ?? createProcessOps()).live;
}

/** The core steps, as they ran, folded into the receipt's effects in run order. */
function effectRecorder() {
  const ordered: ReceiptEffect[] = [];
  return {
    ordered,
    push: (...effects: readonly ReceiptEffect[]) => {
      ordered.push(...effects);
    },
  };
}

/**
 * Run `crewhaus retire` once the spec and its registry pins are read: refuse a live
 * daemon without `--stop`, print the plan on a dry run, otherwise write the receipt and
 * run every step. Returns lines and an exit code; nothing here exits the process.
 *
 * First consumer: `runRetire` in `index.ts`.
 */
export async function retireCommand(o: RetireCommandOptions): Promise<DaemonCommandResult> {
  const opts = o.opts ?? {};
  const env = opts.env ?? process.env;
  const harnessId = harnessIdOf(o.harnessDir, opts);
  const revokers = retireRevokers(AREA_RUNTIMES);
  const now = (opts.clock ?? systemClock).now;
  const items: RetireItem[] = [];
  for (const revoker of revokers) {
    items.push(
      ...(await revoker.plan({
        harnessDir: o.harnessDir,
        ...(harnessId !== undefined ? { harnessId } : {}),
        actor: "",
        now: now(),
      })),
    );
  }
  let plan: ReturnType<typeof buildRetirementPlan>;
  try {
    plan = buildRetirementPlan({
      specName: o.specName,
      harnessDir: o.harnessDir,
      archiveDir: o.archiveDir,
      pins: o.pins,
      force: o.force,
      pushKnowledge: o.pushKnowledge,
      control: { daemonLive: daemonIsLive(o.harnessDir, opts), stop: o.stop, revokerItems: items },
    });
  } catch (err) {
    if (err instanceof RetireError) return { lines: [err.message], exitCode: 1 };
    throw err;
  }
  if (o.dryRun) return { lines: [...formatPlan(plan)], exitCode: 0 };

  const control = directControl(opts);
  try {
    await control.commands.recover({ harness: o.harnessDir });
  } catch {
    // Recovery is the writer's courtesy to the last crash, never a gate on this verb.
  }
  const ops = opts.ops ?? createProcessOps();
  const registry = (() => {
    try {
      return openHangarRegistry({ env });
    } catch {
      return undefined;
    }
  })();
  const answer = await control.commands.submit(
    {
      kind: "controls.retire",
      ...(harnessId !== undefined ? { target: `home/harness/${harnessId}` } : {}),
      ledger: "workspace",
      via: "cli",
      body: { stop: o.stop, force: o.force, forceUnverified: o.forceUnverified },
    },
    async (receipt) => {
      const effects = effectRecorder();
      const core = retireSteps({
        harnessDir: o.harnessDir,
        ...(harnessId !== undefined ? { harnessId } : {}),
        hangarRoot: resolveHangarRoot(env),
        receipt,
        stop: o.stop,
        stopDaemon: async () => {
          const supervisor = supervisorFor(resolveHarness(o.harnessDir, opts), opts, {
            enabled: false,
          });
          try {
            // Adopt before acting: a daemon this process did not start has no pid here.
            await supervisor.adopt();
            const stopped = await supervisor.stop();
            return stopped.stopped
              ? { ok: true, detail: `stopped${stopped.forced ? " (forced)" : ""}` }
              : {
                  ok: false,
                  detail:
                    "a live daemon holds the runfile but was not adopted; nothing was signalled",
                };
          } finally {
            supervisor.close();
          }
        },
        now,
        probe: ops,
        revokers,
        sessionRoot: resolveHarnessSessionRoot(o.harnessDir, loadEnvChain(o.harnessDir).vars).root,
        ...(registry !== undefined ? { registry } : {}),
        holder: { pid: process.pid, host: hostname() },
      });
      let seen = 0;
      const coreStep =
        (run: () => Promise<{ step: string; ok: boolean; detail: string }>) => async () => {
          const outcome = await run();
          const all = core.effects();
          effects.push(...all.slice(seen));
          seen = all.length;
          return outcome;
        };
      const heavyStep =
        <A extends unknown[]>(
          run: (...args: A) => Promise<{ step: string; ok: boolean; detail: string }>,
        ) =>
        async (...args: A) => {
          const outcome = await run(...args);
          effects.push({ kind: `retire.${outcome.step}`, status: outcome.ok ? "done" : "failed" });
          return outcome;
        };
      const steps: RetirementSteps = {
        stopAndDisable: coreStep(core.stopAndDisable),
        cancelQueuedRuns: coreStep(core.cancelQueuedRuns),
        expireDecisions: coreStep(core.expireDecisions),
        revokeStandingRules: coreStep(core.revokeStandingRules),
        revokeConnections: coreStep(core.revokeConnections),
        backupState: heavyStep(o.heavy.backupState),
        complianceEvidence: heavyStep(o.heavy.complianceEvidence),
        auditVerify: heavyStep(o.heavy.auditVerify),
        pushKnowledge: heavyStep(o.heavy.pushKnowledge),
        tombstoneRegistry: heavyStep(o.heavy.tombstoneRegistry),
        recordLifecycle: async () => {
          // The post-archive steps run only once the state is archived.
          effects.push({ kind: "retire.archive", status: "done" });
          return coreStep(core.recordLifecycle)();
        },
        archiveRegistryRow: coreStep(core.archiveRegistryRow),
      };
      try {
        const result = await runRetirement({
          plan,
          steps,
          dryRun: false,
          forceUnverified: o.forceUnverified,
        });
        return {
          settle: { state: "succeeded", effects: effects.ordered },
          value: { lines: [...formatRetirementResult(result)], exitCode: 0 },
        };
      } catch (err) {
        if (!(err instanceof RetireError)) throw err;
        return {
          settle: { state: "failed", effects: effects.ordered, outcome: outcomeOf("internal") },
          value: { lines: [err.message], exitCode: 1 },
        };
      }
    },
  );
  if (!answer.ok) {
    return {
      lines: [`${o.specName}: not retired — ${answer.refusal.message}`],
      exitCode: 1,
    };
  }
  const result = answer.replayed ? undefined : answer.value;
  const lines = result?.lines ?? [];
  const { id, state } = answer.receipt;
  return state === "succeeded"
    ? { lines: [...lines, `Done (${id})`], exitCode: 0 }
    : { lines: [...lines, `Not done (${id})`], exitCode: result?.exitCode || 1 };
}
